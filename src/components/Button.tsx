import type { ButtonHTMLAttributes } from "react";

type Variant = "default" | "primary" | "danger" | "link" | "toolbar" | "toolbar-danger";
type Size = "md" | "sm";

const styles: Record<Variant, string> = {
  default: "border border-line bg-canvas text-ink hover:bg-inset disabled:hover:bg-canvas",
  primary: "border border-transparent bg-accent text-on-accent font-medium hover:bg-accent-hover disabled:hover:bg-accent",
  danger: "border border-line bg-canvas text-err hover:bg-err/8",
  link: "border-0 bg-transparent p-0 text-accent hover:underline",
  toolbar: "border-0 bg-transparent text-ink hover:bg-wash-strong disabled:hover:bg-transparent",
  "toolbar-danger": "border-0 bg-transparent text-err hover:bg-err/10 disabled:hover:bg-transparent",
};

export function Button({
  variant = "default",
  size = "md",
  className = "",
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  const base =
    variant === "link"
      ? "text-[13px] cursor-pointer disabled:opacity-45 disabled:cursor-default"
      : variant === "toolbar" || variant === "toolbar-danger"
        ? "inline-flex items-center justify-center gap-1 h-7 min-w-7 rounded-[6px] px-2 text-[12px] cursor-pointer disabled:opacity-35 disabled:cursor-default"
        : size === "sm"
          ? "inline-flex items-center justify-center gap-1 h-7 rounded-[6px] px-2.5 text-[12px] cursor-pointer disabled:opacity-45 disabled:cursor-default"
          : "rounded-md px-3 py-1.5 text-[13px] cursor-pointer disabled:opacity-45 disabled:cursor-default";
  return <button type={type} className={`${base} ${styles[variant]} ${className}`} {...props} />;
}
