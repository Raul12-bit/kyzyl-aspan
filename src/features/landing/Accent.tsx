/** Highlights one phrase of a headline in the fire colour (same typeface — accents are colour only). */
export function Accent({ text, accent }: { text: string; accent: string }) {
  const i = accent ? text.indexOf(accent) : -1;
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <span className="lp-accent">{accent}</span>
      {text.slice(i + accent.length)}
    </>
  );
}
