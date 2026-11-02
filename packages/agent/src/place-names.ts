/** "中山公园-西湖天下景" or "灵隐寺(东门)" is a part of "中山公园" / "灵隐寺" (Amap lists both). */
export function partOf(name: string, whole: string): boolean {
  return name.length > whole.length && name.startsWith(whole) && "-－(（·".includes(name[whole.length]);
}
