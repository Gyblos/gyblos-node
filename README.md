# Gyblos Payments

Base TypeScript de pagos para Gyblos, un proyecto de inferencia P2P. Separa los adaptadores reutilizables de x402 de los hosts HTTP y del CLI.

La implementación actual prueba pagos reales en **Solana devnet** con un recurso fijo. Todavía no ejecuta modelos ni conecta nodos P2P.

## Rutas disponibles

| Ruta | Facilitador | Comportamiento |
| --- | --- | --- |
| `upto` | Proceso local | Autoriza un techo, cobra un importe menor y devuelve el sobrante mediante un canal de pago. |
| `exact` | x402.org; PayAI como respaldo | Cobra un precio fijo con USDC de Circle en devnet. No mide uso ni devuelve sobrantes. |

Ambas rutas utilizan los paquetes oficiales `@x402/*` fijados en **2.28.0**. La ruta pública `exact` convive con `upto`; no la sustituye.

## Requisitos

- Node.js 22 o superior.
- pnpm 10.12.1.
- Acceso a un RPC de Solana devnet.
- SOL de devnet para la wallet aislada del facilitador local, que también prepara las cuentas de tokens.

## Instalación

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm gate:setup
```

`gate:setup` genera wallets separadas para comprador, vendedor, autorizador, facilitador y mint de prueba. Guarda claves y configuración en `.local/devnet/`, preservando las claves existentes. Esa carpeta está excluida de Git.

Fondea la dirección del facilitador que imprime el comando con al menos **0,05 SOL de devnet** desde el [faucet de Solana](https://faucet.solana.com). Usa exclusivamente las wallets de prueba generadas; no importes wallets de mainnet.

## Pago `upto` con facilitador local

Para preparar un token SPL de prueba de seis decimales y sus cuentas:

```sh
pnpm gate:fund --test-mint
pnpm gate:preflight
pnpm gate:challenge
pnpm gate:run
```

El token se identifica como `devnet-test-token`; **no es USDC**. La preparación no vuelve a acuñar tokens si el mint ya existe.

`gate:run` inicia vendedor y facilitador como procesos separados, ejecuta el comprador y comprueba:

- Apertura y liquidación con transacciones confirmadas y distintas.
- Depósito de 10.000 unidades, cobro de 4.000 y devolución de 6.000.
- Variaciones de saldo del comprador y del vendedor, sin gasto de SOL del comprador.
- Distribución del canal y entrega del recurso fijo.

`gate:challenge` solo comprueba el desafío HTTP 402 sin pagar; no demuestra una liquidación.

Después del recorrido exitoso, puedes ejecutar los casos de comprador sin fondos y autorización vencida:

```sh
pnpm gate:failures
```

La prueba de expiración espera aproximadamente 62 segundos. Los hosts de `upto` usan `127.0.0.1:4021` para el vendedor y `127.0.0.1:4022` para el facilitador.

## Pago `exact` con facilitador público

Solicita **USDC en Solana Devnet** en el [faucet de Circle](https://faucet.circle.com), usando la dirección del comprador generada por `gate:setup`.

Mint aceptado:

```text
4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
```

Después ejecuta:

```sh
pnpm gate:exact
```

El comando sirve un recurso fijo en un puerto local temporal y cobra **10.000 unidades atómicas: 0,01 USDC de devnet**. No inicia el facilitador local. Su wallet aislada solo patrocina la preparación de las cuentas de tokens; el facilitador público paga la comisión del pago.

Antes de firmar, el comprador comprueba red, mint, precio, destinatario y fee payer. El vendedor llama explícitamente a `/verify` y liquida antes de ejecutar el recurso. El recorrido comprueba firma confirmada, deltas de USDC, SOL del comprador estable y rechazo de replay sin otra ejecución.

El proveedor principal es `https://x402.org/facilitator`; el respaldo configurado es `https://facilitator.payai.network`. Se consulta y registra `/supported` antes del pago. Un cambio de capacidad o fee payer detiene el gate. La interoperabilidad pagada se comprobó con x402.org; el respaldo PayAI no se ha probado mediante un pago.

Los casos negativos incluyen otro mint, destinatario o fee payer y comprador sin USDC. Este último se rechaza **localmente antes de firmar**, sin enviar un pago al proveedor.

## Estructura

```text
packages/
  application/       Flujo reutilizable e invariantes contables.
  payments-x402/     Adaptadores upto/exact, confianza y lecturas de cadena.
apps/
  cli/               Configuración, ejecución y presentación de resultados.
  seller/            Hosts HTTP para los recursos fijos.
  facilitator/       Facilitador local para upto.
scripts/             Preparación de wallets, fondeo y utilidades de los gates.
```

Para operar `upto` en terminales separadas: `pnpm gate:facilitator`, `pnpm gate:seller` y `pnpm gate:buyer`.

## Configuración y resultados locales

El RPC predeterminado es `https://api.devnet.solana.com`. Puedes cambiarlo mediante `GYBLOS_RPC_URL` en el entorno del proceso. `GYBLOS_GATE_CONFIG` permite seleccionar otro archivo de configuración. Los comandos no cargan `.env` automáticamente.

La identidad de devnet se comprueba mediante el genesis hash. Las claves permanecen en `.local/devnet/`; nunca deben aparecer en logs ni resultados compartidos.

Las ejecuciones guardan diarios y resultados en `.local/devnet/`. El gate público también escribe `evidence/gate-0004.json`, con capacidades anunciadas, firmas y metadatos públicos. Los directorios de evidencia y los archivos de instrucciones, tests y documentos internos están excluidos de Git.

Para comprobar los tipos del código publicado:

```sh
pnpm typecheck
```

## Límites y recuperación

- Un timeout no demuestra ausencia de cobro, fallo ni reembolso. Una posible liquidación incierta queda registrada y bloquea nuevos pagos hasta conciliarla en cadena.
- La ausencia de una transacción en una consulta de historial no prueba que el pago haya fallado. No se cambia de proveedor automáticamente después de intentar liquidar.
- Un crash puede dejar `buyer.lock` o un diario pendiente. No los borres para repetir el pago sin revisar primero el estado de la autorización y sus transacciones.
- La protección de replay de `exact` está limitada al proceso del vendedor. No se ha validado entre reinicios o vendedores distribuidos.
- El facilitador local usa almacenamiento en memoria. No se ha validado recuperación durable, cierre unilateral ni recuperación posterior de toda la renta del PDA.
- Los gates no validan inferencia real, medición honesta de uso, corrección del contenido, MPP, Iroh, apps móviles ni mainnet. La ruta pública depende de la disponibilidad del tercero.
