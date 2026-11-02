/**
 * V2.7 (after travel-agent-skill): look a stop up on Xiaohongshu and Dianping. Only the place's
 * name goes into the link, as the search word: no API, no data taken back, no position. Both
 * sites may ask the user to log in (checked 2026-10-18); a phone with the app opens it there.
 */
export function platformLinks(name: string): { readonly label: string; readonly url: string }[] {
  const word = encodeURIComponent(name.slice(0, 40));
  return [
    { label: "小红书", url: `https://www.xiaohongshu.com/search_result/?keyword=${word}` },
    // City 3 is Hangzhou on Dianping.
    { label: "大众点评", url: `https://www.dianping.com/search/keyword/3/0_${word}` },
  ];
}

export function PlatformLinks({ name, className = "" }: { name: string; className?: string }) {
  return (
    <p className={`flex items-center gap-2 text-xs text-ink-faint ${className}`}>
      <span>看看评价：</span>
      {platformLinks(name).map((link) => (
        <a
          key={link.label}
          href={link.url}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="underline decoration-line-strong underline-offset-2 hover:text-lake-700"
        >
          {link.label}
        </a>
      ))}
    </p>
  );
}
