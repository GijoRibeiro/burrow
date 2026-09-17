// Playful activity captions, not claims about which tool or task is running.
const phrases = [
  "Thinking",
  "Connecting the dots",
  "Turning the gears",
  "Following the thread",
  "Puzzling it out",
  "Working through it",
  "Putting pieces together",
  "A little brainwork",
  "Deep in thought",
  "Keeping the gears warm",
  "Untangling",
  "Making sense of things",
  "One thought at a time",
  "Still on it",
  "Noodling",
  "Mulling it over",
  "Letting ideas simmer",
  "In the thinking nook",
  "Mind at work",
  "Finding a way through",
  "Doing the brain bits",
  "Thinking in pixels",
  "A thought is brewing",
  "Chasing an idea",
  "Little creature, big thoughts",
  "Wheels turning",
  "Thoughts in motion",
  "Chewing on it",
  "Working the puzzle",
  "In the zone",
  "Taking it step by step",
  "Turning it over",
  "Gathering thoughts",
  "Busy little creature",
  "Thinking cap on",
  "Following the breadcrumbs",
  "Making headway",
  "Staying with it",
  "A few more thoughts",
  "Quietly working away",
];
export function busyPhrases(): () => string {
  const deck = [...phrases];
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  let index = 0;
  return () => `${deck[index++ % deck.length]}…`;
}
