// Icons drawn as Buzz's icon set draws them: Tabler outlines, sized in rem.
import geminiLogo from "../assets/gemini-logo.svg";
import harnessMark from "../assets/harness-mark.svg";
import { h } from "./react.js";

const rem = (size) => (typeof size === "number" ? `${size / 16}rem` : size);

function Tabler({ size = 16, className, paths }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={rem(size)}
      height={rem(size)}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={["tabler-icon", className].filter(Boolean).join(" ")}
      aria-hidden="true"
    >
      <path stroke="none" d="M0 0h24v24H0z" fill="none" />
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

export const CaretDownIcon = (props) => <Tabler {...props} paths={["M6 9l6 6l6 -6"]} />;
export const CheckIcon = (props) => <Tabler {...props} paths={["M5 12l5 5l10 -10"]} />;
/** Buzz's CircleNotchIcon (Tabler loader-2), the button spinner. */
export const SpinnerIcon = (props) => <Tabler {...props} paths={["M12 3a9 9 0 1 0 9 9"]} />;

function picture(href) {
  return function Picture({ size = 20, className }) {
    return (
      <svg width={rem(size)} height={rem(size)} viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden="true">
        <image href={href} width="32" height="32" />
      </svg>
    );
  };
}

/** Gemini's sparkle, beside each Gemini model. */
export const GeminiLogoIcon = picture(geminiLogo);
/** This harness's mark: Gemini's sparkle with a "+" badge, Gemini extended. */
export const HarnessIcon = picture(harnessMark);
