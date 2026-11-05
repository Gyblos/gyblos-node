// Shared navigation and the Spanish interface strings (Fumadocs has no Spanish pack).
import { uiTranslations } from 'fumadocs-ui/i18n';
import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';

import { i18n } from './i18n';
import { websiteUrl } from './shared';

export const translations = i18n
  .translations()
  .extend(uiTranslations())
  .add({
    en: { displayName: 'English' },
    es: {
      displayName: 'Español',
      'Ask AI(AI chat button)': 'Preguntar a la IA',
      'Back to Home(404 not found page)': 'Volver al inicio',
      'Choose a language(language switcher)': 'Elige un idioma',
      'Choose a language(language switcher)(aria-label)': 'Elige un idioma',
      'Close Banner(banner)(aria-label)': 'Cerrar aviso',
      'Close Search(search dialog)(aria-label)': 'Cerrar búsqueda',
      'Close Sidebar(aria-label)': 'Cerrar menú',
      'Close Sidebar(sidebar)(aria-label)': 'Cerrar menú',
      'Close(image zoom)(aria-label)': 'Cerrar',
      'Collapse Sidebar(sidebar)(aria-label)': 'Contraer menú',
      'Copied Anchor Link(heading anchor)(aria-label)': 'Enlace copiado',
      'Copied Link(accordion)(aria-label)': 'Enlace copiado',
      'Copied Markdown(page actions)': 'Markdown copiado',
      'Copied Text(code block)(aria-label)': 'Texto copiado',
      'Copy Anchor Link(heading anchor)(aria-label)': 'Copiar enlace',
      'Copy Link(accordion)(aria-label)': 'Copiar enlace',
      'Copy Markdown(page actions)': 'Copiar Markdown',
      'Copy Text(code block)(aria-label)': 'Copiar texto',
      'Dark(theme switcher)(aria-label)': 'Oscuro',
      'Default(type table)': 'Por defecto',
      'Edit on GitHub(edit page)': 'Editar en GitHub',
      'Hide Sidebar(sidebar)': 'Ocultar menú',
      'Image Viewer(image zoom)(aria-label)': 'Visor de imágenes',
      'Language(language switcher)': 'Idioma',
      'Last updated on(page footer)': 'Última actualización',
      'Layout Tab(layout tab trigger)': 'Pestaña',
      'Light(theme switcher)(aria-label)': 'Claro',
      'Next Image(image zoom)(aria-label)': 'Imagen siguiente',
      'Next Page(pagination)': 'Siguiente',
      'No Headings(table of contents)': 'Sin secciones',
      'No results found(search dialog)': 'Sin resultados',
      'On this page(table of contents)': 'En esta página',
      'Open Search(search trigger)(aria-label)': 'Abrir búsqueda',
      'Open Sidebar(aria-label)': 'Abrir menú',
      'Open Sidebar(sidebar)(aria-label)': 'Abrir menú',
      'Open in ChatGPT(page actions)': 'Abrir en ChatGPT',
      'Open in Claude(page actions)': 'Abrir en Claude',
      'Open in Cursor(page actions)': 'Abrir en Cursor',
      'Open in GitHub(page actions)': 'Abrir en GitHub',
      'Open in Scira AI(page actions)': 'Abrir en Scira AI',
      'Open(page actions)': 'Abrir',
      'Options(aria-label)': 'Opciones',
      'Page Not Found(404 not found page)': 'Página no encontrada',
      'Parameters(type table)': 'Parámetros',
      'Previous Image(image zoom)(aria-label)': 'Imagen anterior',
      'Previous Page(pagination)': 'Anterior',
      'Prop(type table)': 'Propiedad',
      'Read {url}, I want to ask questions about it.(page actions)':
        'Lee {url}, quiero hacer preguntas sobre esto.',
      'Returns(type table)': 'Devuelve',
      'Search failed(search dialog)': 'La búsqueda falló',
      'Search failed, showing results for {query}(search dialog)':
        'La búsqueda falló; resultados para {query}',
      'Search(search dialog)': 'Buscar',
      'Search(search trigger)': 'Buscar',
      'Show Sidebar(sidebar)': 'Mostrar menú',
      'System(theme switcher)(aria-label)': 'Sistema',
      'Table of Contents(inline table of contents)': 'Contenido',
      'The page you are looking for might have been removed, had its name changed, or is temporarily unavailable.(404 not found page)':
        'La página que buscas no existe, cambió de nombre o no está disponible por ahora.',
      'Theme(site menu)': 'Tema',
      'Toggle Menu(home layout header)(aria-label)': 'Abrir o cerrar menú',
      'Toggle Theme(theme switcher)(aria-label)': 'Cambiar tema',
      'Type(type table)': 'Tipo',
      'View as Markdown(page actions)': 'Ver como Markdown',
    },
  });

export function baseOptions(locale: string): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="flex items-center gap-2 font-mono font-medium">
          <img
            src="/gyblos-mark-holographic-dark.svg"
            alt=""
            width={28}
            height={28}
            className="hidden dark:block"
          />
          <img
            src="/gyblos-mark-holographic-light.svg"
            alt=""
            width={28}
            height={28}
            className="dark:hidden"
          />
          <span>
            gyblos <span className="text-fd-muted-foreground">docs</span>
          </span>
        </span>
      ),
      url: `/${locale}`,
    },
    // An icon link sits in the sidebar footer next to the theme switch, which is otherwise an empty row.
    links: [
      {
        type: 'icon',
        text: 'gyblos.com',
        label: 'gyblos.com',
        icon: <WebsiteIcon />,
        url: locale === 'es' ? `${websiteUrl}/es` : websiteUrl,
        external: true,
      },
    ],
  };
}

// A globe (the lucide shape, inline so the app needs no icon package).
function WebsiteIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
      <path d="M2 12h20" />
    </svg>
  );
}
