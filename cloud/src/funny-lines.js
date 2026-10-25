/* Funny lines for the customer's phone tracker (/r/<ref>). EDIT HERE; this is the only copy.
   The Worker injects these arrays at the top of the phone page's script when it serves the
   page, and a future "your drink is ready" text message can import READY_LINES from here too.
   Keep them clean and family-friendly (kids use the kiosk).
   {name} = the name the customer typed at the kiosk. When there's no name, a leading
   "{name}, " / "{name}! " is dropped and the line starts with a capital letter instead
   (see fillLine below, which the page uses as well).                                      */

export const READY_LINES = [
  "{name}, your drink is ready and frankly it's showing off.",
  "Ready! It's colder than your ex. Come grab it.",
  "Your drink is ready. It refuses to wait any longer and so should you.",
  "Order up! Walk, don't run. Okay, run a little.",
  "Ready at the window. It's been practicing its pose.",
  "Your drink has entered the chat. And the window.",
  "Ready! Fizz levels are critical. Report to the window.",
  "{name}! Your sip ship has docked.",
  "{name}, your drink is sweating. Please come rescue it.",
  "Ready! This is not a drill. Okay, it's a drink.",
  "Your cup runneth over. Well, almost. Come get it.",
  "High tide! Your drink just washed up at the window.",
];

export const MAKING_LINES = [
  "Pumping syrup with feeling...",
  "Your drink is getting its beach body.",
  "Adding ice. Lots of ice. A concerning amount of ice.",
  "Shaking it like it owes us money.",
  "Cream is going in. The soda is nervous.",
  "Consulting the Soda Council...",
  "Almost there. The drink is choosing its outfit.",
  "Teaching the bubbles to line up nicely...",
  "Your drink is doing a little sandcastle of foam.",
  "Applying sunscreen to your cup. Safety first.",
  "{name}, your drink is in the shaker and loving it.",
];

/* Same function is shipped to the page (as source), so the SMS can reuse it later. */
export function fillLine(line, name) {
  const n = String(name || "").trim();
  if (n) return line.split("{name}").join(n);
  let s = line.replace(/^\{name\}[,!.:]?\s*/, "").split("{name}").join("friend");
  return s.charAt(0).toUpperCase() + s.slice(1);
}
