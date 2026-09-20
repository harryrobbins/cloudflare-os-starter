// A small built-in emoji set: enough for a picker and for `:shortcode:` completion, without shipping a
// 1,800-entry table the bundle would have to carry. Grouped in the order the picker shows them.

export interface EmojiEntry {
  readonly emoji: string;
  readonly name: string;
  readonly keywords?: readonly string[];
}

export interface EmojiGroup {
  readonly label: string;
  readonly entries: readonly EmojiEntry[];
}

export const EMOJI_GROUPS: readonly EmojiGroup[] = [
  {
    label: "Reactions",
    entries: [
      { emoji: "👍", name: "thumbsup", keywords: ["+1", "yes", "ok"] },
      { emoji: "👎", name: "thumbsdown", keywords: ["-1", "no"] },
      { emoji: "🎉", name: "tada", keywords: ["party", "ship"] },
      { emoji: "✅", name: "white_check_mark", keywords: ["done", "check"] },
      { emoji: "❌", name: "x", keywords: ["no", "fail"] },
      { emoji: "👀", name: "eyes", keywords: ["looking", "review"] },
      { emoji: "🙏", name: "pray", keywords: ["thanks", "please"] },
      { emoji: "🔥", name: "fire", keywords: ["hot", "great"] },
      { emoji: "💯", name: "hundred", keywords: ["perfect"] },
      { emoji: "🚀", name: "rocket", keywords: ["ship", "deploy"] },
      { emoji: "⚠️", name: "warning", keywords: ["careful"] },
      { emoji: "🐛", name: "bug", keywords: ["issue", "defect"] },
    ],
  },
  {
    label: "Smileys",
    entries: [
      { emoji: "😀", name: "grinning" },
      { emoji: "😄", name: "smile" },
      { emoji: "😅", name: "sweat_smile" },
      { emoji: "😂", name: "joy", keywords: ["lol"] },
      { emoji: "🙂", name: "slightly_smiling_face" },
      { emoji: "😉", name: "wink" },
      { emoji: "😍", name: "heart_eyes" },
      { emoji: "🤔", name: "thinking" },
      { emoji: "😴", name: "sleeping" },
      { emoji: "😬", name: "grimacing" },
      { emoji: "😢", name: "cry" },
      { emoji: "🤯", name: "exploding_head" },
    ],
  },
  {
    label: "People",
    entries: [
      { emoji: "👋", name: "wave", keywords: ["hello"] },
      { emoji: "🤝", name: "handshake" },
      { emoji: "💪", name: "muscle" },
      { emoji: "🧑‍💻", name: "technologist", keywords: ["dev", "coding"] },
      { emoji: "🙋", name: "raising_hand" },
      { emoji: "🫡", name: "salute" },
    ],
  },
  {
    label: "Objects",
    entries: [
      { emoji: "📌", name: "pushpin", keywords: ["pin"] },
      { emoji: "📎", name: "paperclip", keywords: ["attach"] },
      { emoji: "📝", name: "memo", keywords: ["note"] },
      { emoji: "📷", name: "camera", keywords: ["photo"] },
      { emoji: "🗓️", name: "calendar" },
      { emoji: "☕", name: "coffee" },
      { emoji: "🍕", name: "pizza" },
      { emoji: "🎯", name: "dart", keywords: ["target", "goal"] },
      { emoji: "💡", name: "bulb", keywords: ["idea"] },
      { emoji: "🔗", name: "link" },
      { emoji: "🧪", name: "test_tube", keywords: ["test"] },
      { emoji: "❤️", name: "heart", keywords: ["love"] },
    ],
  },
];

export const ALL_EMOJI: readonly EmojiEntry[] = EMOJI_GROUPS.flatMap((group) => group.entries);

/** The row of one-click reactions on the hover action bar. */
export const QUICK_REACTIONS: readonly string[] = ["👍", "🎉", "👀", "✅", "❤️"];

/** Shortcode lookup for the `:` autocomplete. Prefix match on name, then on a keyword. */
export function searchEmoji(query: string, limit = 8): readonly EmojiEntry[] {
  const needle = query.toLowerCase();
  if (needle.length === 0) return ALL_EMOJI.slice(0, limit);
  const byName = ALL_EMOJI.filter((entry) => entry.name.startsWith(needle));
  const byKeyword = ALL_EMOJI.filter(
    (entry) =>
      !byName.includes(entry) &&
      (entry.name.includes(needle) ||
        (entry.keywords ?? []).some((keyword) => keyword.startsWith(needle))),
  );
  return [...byName, ...byKeyword].slice(0, limit);
}
