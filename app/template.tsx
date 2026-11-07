/** Remounts on every navigation, so each page eases in as you arrive (the .page-in animation in globals.css). */
export default function Template({ children }: { children: React.ReactNode }) {
  return <div className="page-in">{children}</div>;
}
