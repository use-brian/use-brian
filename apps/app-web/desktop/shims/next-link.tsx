/**
 * `next/link` shim → react-router `Link`. Aliased in vite.desktop.config.ts.
 * app-web passes string `href`s; Next-only props (prefetch/replace/scroll)
 * are accepted and dropped.
 */
import { Link as RouterLink } from "react-router-dom";
import type { AnchorHTMLAttributes, ReactNode } from "react";

type NextLinkProps = {
  href: string;
  children?: ReactNode;
  prefetch?: boolean;
  replace?: boolean;
  scroll?: boolean;
} & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">;

export default function Link({ href, children, prefetch: _p, replace, scroll: _s, ...rest }: NextLinkProps) {
  return (
    <RouterLink to={href} replace={replace} {...rest}>
      {children}
    </RouterLink>
  );
}
