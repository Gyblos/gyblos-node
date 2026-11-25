const ARM_COUNT = 6;
const FULL_ROTATION = 360;
const ARM_ANGLES = Array.from(
  { length: ARM_COUNT },
  (_, index) => (index * FULL_ROTATION) / ARM_COUNT,
);
const ARM_DELAY_SECONDS = 0.38;
export function NodeGlyph() {
  return (
    <svg
      className="preview-node-hex network-glyph"
      viewBox="0 0 144 128"
      aria-hidden="true"
    >
      {ARM_ANGLES.map((angle, i) => (
        <g
          key={i}
          transform={'rotate(' + angle + ' 72 64)'}
          style={{ animationDelay: i * ARM_DELAY_SECONDS + 's' }}
        >
          <path className="hex-trace" d="M72 52 V12 L117.03 38" />
          {['trail', 'head'].map((part) => (
            <path
              key={part}
              className={'hex-current hex-' + part}
              pathLength="100"
              d="M72 52 V12 L117.03 38"
            />
          ))}
          <circle className="hex-halo" cx="72" cy="12" r="7" />
          <circle className="hex-terminal" cx="72" cy="12" r="4" />
        </g>
      ))}
      <path
        fill="currentColor"
        transform="translate(58.6 72.7) scale(.045 -.045)"
        d="M297 -162Q234 -162 186.5 -143Q139 -124 108 -89Q77 -54 66 -8L190 0Q199 -29 224 -45.5Q249 -62 297 -62Q359 -62 391.5 -35Q424 -8 424 44L424 114Q405 75 366.5 51.5Q328 28 273 28Q208 28 157 60.5Q106 93 77 151Q48 209 48 284Q48 363 76.5 421.5Q105 480 155 513Q205 546 270 546Q325 546 365.5 521Q406 496 426 452L428 534L542 534L542 55Q542 -16 512 -64.5Q482 -113 427 -137.5Q372 -162 297 -162ZM297 127Q353 127 388 168Q423 209 424 286Q424 337 408.5 373Q393 409 364 427.5Q335 446 297 446Q237 446 204 404.5Q171 363 171 286Q171 209 204.5 168Q238 127 297 127Z"
      />
    </svg>
  );
}
