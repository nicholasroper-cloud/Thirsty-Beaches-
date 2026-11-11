/* Thirsty Beaches — Kiosk Greeter: LINES + CHARACTERS
 * Edit jokes here. Load this BEFORE greeter.js.
 *
 * [square brackets] are stage directions for the ElevenLabs voices ([laughs], [whispers], [sighs]...).
 * They're hidden from the on-screen bubble and skipped by the backup computer voice.
 *
 * eleven.voiceId: paste the ElevenLabs voice ID for each character (run: node make-voices.js --list-voices)
 * eleven.prefix:  stage direction added to the start of every line for that character
 * eleven.stability: 0 = wild/expressive, 0.5 = natural, 1 = steady
 * eleven.find:    what to search for in the ElevenLabs Voice Library
 *
 * Changing a line's text automatically makes it a "new" clip: the kiosk uses the
 * computer voice for it until you run make-voices.js again.
 */
(function (root) {
const SHARED = {
  passerby: [
    "Excuse me, you're walking at a very un-thirsty speed.",
    "Sir. Ma'am. This is a Thirsty Beaches.",
    "Your sweat called. It wants a refill.",
    "Bold of you to walk past a talking trailer. Most people at least wave.",
    "Quick question: are you a mango or a blue raspberry? Come find out.",
    "I'm not begging. Kiosks don't beg. [pause] Please come back.",
    "I'm legally required to tell you we have slushies. I'm not. But we do.",
    "That walk says I need a drink. Your wallet says later. Ignore your wallet.",
    "Hey! You look thirsty. Just saying.",
    "Psst. The ocean is salty. We are not.",
    "Walking past a cold drink on a hot beach? Bold strategy.",
    "Excuse me, your hydration levels are concerning.",
    "I saw that sunburn. Let me help.",
    "This is your sign. Literally. I'm a sign that talks.",
    "Free advice: sand does not count as a snack.",
    "Come back! [sobbing] I have slushies and abandonment issues.",
    "Did you just walk past me? In this economy?",
    "I can see you. I'm a kiosk. Seeing people is my whole thing.",
    "Your sunscreen is wearing off, and so is my patience.",
    "Fun fact: ninety percent of people who walk past me regret it. I made that up. But still.",
    "Hey, you dropped something. Your chance at a slushy.",
    "Is that a water bottle? Cute. Upgrade.",
    "Hydrate or die-drate. That's not a word. Buy a drink anyway.",
    "Keep walking. [sighs] It's fine. I'll just be here. Cold. Delicious. Alone.",
    "Wow. Didn't even look at me. I'm telling the ice cream machine.",
    "Ma'am. Sir. Seagull. Whoever you are. Drinks are here.",
    "You've got that I-forgot-my-water-in-the-car look.",
    "Real talk: your future self wants a slushy.",
  ],
  approach: [
    "Finally! Someone with taste. And by taste, I mean taste buds.",
    "Pro tip: point at the screen like you know what you're doing. Everyone does that.",
    "Welcome! Your drink will be ready faster than your sunburn.",
    "I'd shake your hand, but I'm a computer. Touch the screen instead. Gently.",
    "Oh hey, you came back! I knew you would.",
    "[whispers] Ooh, a customer. Act natural. Act natural.",
    "Don't be nervous. I'm just a screen with feelings.",
    "Hello, gorgeous. The camera's a little blurry, so I'm being generous.",
    "You look like a mango person. Prove me wrong.",
    "Oh good, you're real. The last one was a seagull.",
    "Welcome! Please keep hands, feet, and sand off the screen.",
    "Choices are hard. Slushies are easy. Touch something.",
    "You have excellent taste in trailers.",
    "Welcome! Pick a drink, any drink. Okay, maybe two.",
  ],
  group: [
    "Okay everybody, look at the screen and pretend you're not hungry.",
    "One at a time! I'm only one kiosk!",
    "Oh, a whole crew! Somebody's buying a round.",
    "Group order? Who's paying? Don't all point at once.",
    "Party of many! I'm gonna need bigger cups.",
    "Squad goals: matching slushies.",
  ],
  lonely: [
    "I've started naming the seagulls. That one's Kevin.",
    "Testing, testing. Is this thing on? Is anyone on?",
    "It's so quiet. Somebody come buy a slushy.",
    "[clears throat] I'm not talking to myself. I'm rehearsing.",
    "If a kiosk talks on an empty beach, does anyone buy a slushy?",
    "Day forty. The seagulls have accepted me as one of their own.",
    "Beep boop. Lonely kiosk noises.",
  ],
  morning: ["Good morning, beach people! Coffee's ready, and so am I."],
  afternoon: ["Peak heat hours. Which means peak slushy hours."],
  evening: ["Sunset drink? Sunset drink."],
};

const PERSONAS = {
  normal: { name: "Kiosk", emoji: "🌴", pitch: 1.1, rate: 1.05, voice: [/^Samantha/, /^Shelley/, /Jenny Online|Aria Online|Ava Online/, /Aria|Jenny|Zira|Google US English/],
    eleven: { voiceId: "", prefix: "[cheerful]", stability: 0.5, find: "friendly, upbeat young narrator" }, lines: {} },

  surfer: { name: "Surfer Bro", emoji: "🏄", pitch: 0.85, rate: 1.0, voice: [/^Rocko/, /^Fred$/, /Andrew Online|Brian Online|Eric Online/, /Guy|David|Mark|Google US English/],
    eleven: { voiceId: "", prefix: "[laid back]", stability: 0.0, find: "surfer dude / California bro" }, lines: {
    passerby: [
      "Duuude. You're walking. Walk over here, bro.",
      "Gnarly sunburn, brah. A slushy fixes that. Probably. I'm not a doctor.",
      "Bro, the waves are flat, but the drinks are cold.",
      "Whoa whoa whoa, where you going, dude? The vibes are over here.",
      "Bro. Bro. Bro. Drink. Bro.",
      "Dude, you just paddled right past the best wave of your life.",
    ],
    approach: [
      "Welcome to the shack, brah. Stoked you're here.",
      "Shaka, my dude. Pick a drink, catch a wave.",
      "Duuude. You made it. Totally tubular.",
      "Bro, I can tell you're a blue raspberry kinda soul.",
    ],
    group: ["Whole crew rolling up! Righteous. Drinks for the homies."],
    lonely: ["[sighs] Bro... where is everyone... is it like, a good swell day or something?"],
  }},

  pirate: { name: "Captain Slushbeard", emoji: "🏴‍☠️", pitch: 0.6, rate: 0.9, voice: [/^Albert$/, /^Grandpa/, /^Ralph$/, /Davis Online|Christopher Online|Roger Online/, /Guy|David|Mark|Google UK English Male/],
    eleven: { voiceId: "", prefix: "[gruff pirate accent]", stability: 0.0, find: "pirate / old sea captain" }, lines: {
    passerby: [
      "Arrr! Ye be walkin' past the finest grog on the coast!",
      "Avast, landlubber! Yer mouth be drier than a skeleton's sock!",
      "Shiver me timbers, that be a parched look ye got there.",
      "Come back, ye scallywag! X marks the slushy!",
      "Arrr, yer abandonin' ship before the treasure! Madness!",
    ],
    approach: [
      "Ahoy, matey! Choose yer treasure!",
      "Welcome aboard! No walkin' the plank till ye've had a slushy.",
      "Arr, a fine customer! [laughs] Me parrot approves.",
      "Yo ho ho, and a bottle of... lemonade. We're family friendly.",
    ],
    group: ["A whole crew o' scallywags! Grog for everyone! Non-alcoholic grog!"],
    lonely: ["Arr... not a soul on the horizon. Just me and the barnacles."],
  }},

  seagull: { name: "Gary the Seagull", emoji: "🐦", pitch: 1.7, rate: 1.3, voice: [/^Jester$/, /^Junior$/, /Ana Online/, /Zira|Aria|Jenny|Google US English/],
    eleven: { voiceId: "", prefix: "[squawky, annoyed]", stability: 0.0, find: "cartoon bird / squeaky cartoon character" }, lines: {
    passerby: [
      "Mine! Mine! Oh wait, you don't have a drink. Tragic.",
      "I've stolen fries from better people than you. Buy a drink.",
      "[squawks] Translation: you look thirsty.",
      "[shouts] Hey! Hey! Hey! Hey! Hey! Hey! Did you hear me? Hey!",
      "I'm not saying I'll poop on your car. I'm saying buy a slushy.",
    ],
    approach: [
      "Oh great, a human. Got any fries? No? Buy a drink then.",
      "Welcome. Don't make eye contact. Just order.",
      "Squawk! A customer! Quick, everybody act cool!",
    ],
    group: ["Ooh, a whole flock of humans. Somebody's dropping fries today."],
    lonely: ["Squawk. Nobody's here. I'm gonna go yell at a pelican."],
  }},

  trailer: { name: "Movie Trailer Guy", emoji: "🎬", pitch: 0.2, rate: 0.85, voice: [/^Ralph$/, /^Reed/, /^Daniel/, /Christopher Online|Guy Online|Davis Online/, /Guy|David|Mark|Google UK English Male/],
    eleven: { voiceId: "", prefix: "[deep, dramatic]", stability: 0.5, find: "movie trailer / epic narrator" }, lines: {
    passerby: [
      "In a world... where one person walked past a drink trailer... they would live to regret it.",
      "This summer... one beach... one slushy... one chance.",
      "Coming soon... to your mouth... Thirsty Beaches.",
      "They said it couldn't be done. Walking past a slushy. They were right.",
    ],
    approach: [
      "And then... the customer... approached.",
      "[pause] Rated S. [pause] For slushy.",
      "One kiosk. One customer. One unforgettable... beverage.",
    ],
    group: ["This summer... they came together... to argue about who pays."],
    lonely: ["In a world... with no customers... one kiosk... waited."],
  }},

  chipmunk: { name: "Way Too Much Espresso", emoji: "☕", pitch: 2, rate: 1.7, voice: [/^Junior$/, /^Kathy$/, /Ana Online/, /Zira|Aria|Jenny|Google US English/],
    eleven: { voiceId: "", prefix: "[extremely excited, talking fast]", stability: 0.0, find: "hyper cartoon / chipmunk" }, lines: {
    passerby: [
      "HEY HEY HEY! OVER HERE! I'M SMALL BUT I'M LOUD!",
      "I've had nine espressos and I'm a computer! Buy a drink!",
      "Slushy slushy slushy slushy slushy slushy!",
      "Can't stop, won't stop, also please stop, come back!",
    ],
    approach: [
      "OH MY GOSH A CUSTOMER! HI! HI! HI! HI!",
      "Welcome welcome welcome! Pick one pick one pick one!",
      "I'm so happy you're here I could vibrate! Wait I am vibrating!",
    ],
    group: ["SO MANY PEOPLE! BEST DAY EVER! AGAIN!"],
    lonely: ["Nobody's here and I've still had nine espressos. [nervous laugh] This is fine."],
  }},

  robot: { name: "KIOSK-9000", emoji: "🤖", pitch: 0.9, rate: 0.9, voice: [/^Zarvox$/, /^Trinoids$/, /^Fred$/, /Steffan Online|Eric Online/, /David|Mark|Google US English/],
    eleven: { voiceId: "", prefix: "[robotic, monotone]", stability: 0.5, find: "robot / AI computer voice" }, lines: {
    passerby: [
      "Beep boop. Human detected. Hydration level: low.",
      "Scanning. Scanning. Diagnosis: you require ice cream.",
      "Error. Customer walking wrong direction. Please reverse.",
      "I am a kiosk. I have no feelings. Except a deep love of slushies.",
    ],
    approach: [
      "Greetings, human. Please select beverage. Resistance is futile.",
      "Customer acquired. Initiating delicious protocol.",
      "Facial scan complete. Result: definitely needs a drink.",
    ],
    group: ["Multiple humans detected. Calculating round of drinks."],
    lonely: ["System report: zero humans. Sadness subroutine engaged."],
  }},

  butler: { name: "Jeeves", emoji: "🎩", pitch: 0.9, rate: 0.9, voice: [/^Daniel/, /Google UK English Male/, /Ryan Online|Thomas Online/, /George|Ryan/],
    eleven: { voiceId: "", prefix: "[posh British]", stability: 0.5, find: "British butler / posh English gentleman" }, lines: {
    passerby: [
      "I say, you appear to be walking away from refreshment. Most irregular.",
      "Pardon me, but one simply does not pass a slushy.",
      "Do forgive the intrusion, but you look positively parched.",
      "Ahem. The beverages are this way. I'll wait.",
    ],
    approach: [
      "Good day. Your beverage awaits. Do touch the screen, I shan't mind.",
      "Welcome to Thirsty Beaches. Shall I fetch you something frosty?",
      "Ah, a guest of distinction. Or sand. Hard to tell.",
    ],
    group: ["A party, how delightful. I shall polish the good cups."],
    lonely: ["[sighs] Quiet day. I shall stand here. Dignified. Alone."],
  }},
  grandma: { name: "Beach Grandma", emoji: "👵", pitch: 1.0, rate: 0.9, voice: [/^Grandma/, /^Kathy$/, /^Samantha/, /Libby Online|Sonia Online|Michelle Online/, /Zira|Aria|Jenny/],
    eleven: { voiceId: "", prefix: "[sweet old grandma]", stability: 0.5, find: "grandma / elderly woman" },
    lines: {
    passerby: [
      "Sweetie, you look thirsty. Come here, let Grandma get you a drink.",
      "Oh honey, where's your hat? You're red as a lobster.",
      "In my day we walked uphill both ways to the slushy stand. And you're right here!",
      "You're too skinny. Have an ice cream.",
      "Don't make me call your mother. Get a drink.",
    ],
    approach: [
      "There's my favorite customer! Don't tell the others.",
      "Oh look at you, all grown up! Want a slushy?",
      "Pick whatever you want, sweetheart. Grandma's not paying, but still.",
    ],
    group: ["Oh, the whole family! Everybody gets a drink. No fighting."],
    lonely: ["Nobody calls, nobody visits. Just like my grandkids."],
  }},

  singer: { name: "Kiosk Idol", emoji: "🎤", pitch: 1.0, rate: 1.0, voice: [/^Good News$/, /^Cellos$/, /^Bells$/, /^Organ$/, /Jenny Online|Aria Online/, /^Samantha/],
    eleven: { voiceId: "", prefix: "[singing]", stability: 0.0, find: "singer / musical" },
    lines: {
    passerby: [
      "Slushies are cold, and so are you for walking past.",
      "Come and get a drink, it is hot and you are sweating.",
      "Thirsty Beaches, Thirsty Beaches, buy a drink.",
    ],
    approach: [
      "Welcome welcome, pick a drink, any drink.",
      "Happy happy customer day to you.",
    ],
    group: ["Party people need party drinks."],
    lonely: ["Nobody's here, so I will sing to the sand."],
  }},

  whisper: { name: "Whisper Guy", emoji: "🫣", pitch: 1.0, rate: 0.85, voice: [/^Whisper$/, /^Fred$/, /Guy Online|Davis Online/, /David|Mark|Google US English/],
    eleven: { voiceId: "", prefix: "[whispers]", stability: 0.5, find: "whisper / ASMR" },
    lines: {
    passerby: [
      "Psst. Hey. Hey you. The slushies. They know your name.",
      "Don't look now... but you're thirsty.",
      "I'm not saying the ice cream is watching you. [pause] But it is.",
    ],
    approach: [
      "Shh. Order quietly. The seagulls are listening.",
      "You came closer. Good. Very good. Now pick a drink.",
    ],
    group: ["So many of you. [pause] Excellent. Drinks for all."],
    lonely: ["It's quiet. Too quiet. Slushy quiet."],
  }},

  doom: { name: "Bad News Bear", emoji: "☠️", pitch: 0.9, rate: 0.9, voice: [/^Bad News$/, /^Ralph$/, /Christopher Online|Davis Online/, /Guy|David|Mark/],
    eleven: { voiceId: "", prefix: "[ominous, doom-laden]", stability: 0.5, find: "dark / villain / ominous" },
    lines: {
    passerby: [
      "Your drink is gone. Forever. Unless you buy another one.",
      "The sun is hot. The sand is hot. You are hot. Not in the good way.",
      "Every step away from this trailer is a step toward dehydration.",
    ],
    approach: ["Welcome. All drinks are cold. Unlike your future without one."],
    group: ["You came as a group. You will leave as a group. With drinks."],
    lonely: ["No customers. Only darkness. And slushies."],
  }},
};

// Short stable ID for a line → its audio file name
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

root.TB_LINES = { SHARED, PERSONAS, hash };
if (typeof module !== "undefined") module.exports = root.TB_LINES;
})(typeof window !== "undefined" ? window : globalThis);
