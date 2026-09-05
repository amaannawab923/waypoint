/**
 * The Jira brand mark — a filled, three-layer glyph (Atlassian's own logo
 * shape), not this app's usual stroke-based icon set (components/icons),
 * since a brand mark should render as the actual logo rather than an
 * outline approximation. Shared between the sidebar's "My Jira" nav item and
 * MyJiraPage's own header so both render the identical glyph.
 */
export function JiraMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M11.53 2c0 2.4 1.97 4.35 4.4 4.35h1.8v1.72c0 2.4 1.96 4.34 4.37 4.35V2.87A.87.87 0 0 0 21.23 2H11.53Z"
        fill="currentColor"
      />
      <path
        d="M6.36 7.13c0 2.4 1.97 4.35 4.4 4.35h1.8v1.72c0 2.4 1.96 4.35 4.37 4.35V8c0-.48-.4-.87-.87-.87H6.36Z"
        fill="currentColor"
        opacity=".72"
      />
      <path
        d="M1.2 12.26c0 2.4 1.96 4.35 4.39 4.35h1.8v1.71c0 2.4 1.96 4.35 4.38 4.35v-9.54a.87.87 0 0 0-.87-.87H1.2Z"
        fill="currentColor"
        opacity=".46"
      />
    </svg>
  );
}
