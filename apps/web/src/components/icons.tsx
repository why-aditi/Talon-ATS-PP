// ponytail: nine hand-rolled line icons instead of an icon package. lucide-react is the
// obvious dependency, but this screen needs nine glyphs and the whole file is smaller
// than the import graph it would replace. Add the package when a screen needs dozens.
type IconProps = { className?: string };

function Icon({ className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {children}
    </svg>
  );
}

export const BriefcaseIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="1.75" y="4.75" width="12.5" height="8.5" rx="1.5" />
    <path d="M5.75 4.5V3.4c0-.5.4-.9.9-.9h2.7c.5 0 .9.4.9.9v1.1" />
  </Icon>
);

export const BoardIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="1.75" y="2.75" width="3.5" height="10.5" rx="1" />
    <rect x="6.75" y="2.75" width="3.5" height="7" rx="1" />
    <rect x="11.75" y="2.75" width="2.5" height="5" rx="1" />
  </Icon>
);

export const InboxIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" />
    <path d="M1.75 9.5h3l1 1.5h4.5l1-1.5h3" />
  </Icon>
);

export const PersonIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="5.5" r="2.5" />
    <path d="M2.75 13.5c0-2.6 2.4-4 5.25-4s5.25 1.4 5.25 4" />
  </Icon>
);

export const CalendarIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="1.75" y="3.25" width="12.5" height="10" rx="1.5" />
    <path d="M1.75 6.5h12.5M5 1.75v2.5M11 1.75v2.5" />
  </Icon>
);

export const DocumentIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3.25 2.75h6L12.75 6v7.25a1 1 0 0 1-1 1h-8.5a1 1 0 0 1-1-1V3.75a1 1 0 0 1 1-1Z" />
    <path d="M9 2.75V6h3.75" />
  </Icon>
);

export const ChartIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 13.25V8M8 13.25V3.5M13 13.25v-3.5" />
  </Icon>
);

export const SearchIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="7.25" cy="7.25" r="4.5" />
    <path d="m10.6 10.6 2.65 2.65" />
  </Icon>
);

export const BellIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 6.75a4 4 0 0 1 8 0c0 3 1 4 1 4H3s1-1 1-4Z" />
    <path d="M6.75 13a1.5 1.5 0 0 0 2.5 0" />
  </Icon>
);

export const SignOutIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9.75 2.75h-6a1 1 0 0 0-1 1v8.5a1 1 0 0 0 1 1h6" />
    <path d="M11 5.5 13.5 8 11 10.5M13.25 8H6.5" />
  </Icon>
);

export const ChevronDownIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m4.5 6.5 3.5 3.5 3.5-3.5" />
  </Icon>
);
