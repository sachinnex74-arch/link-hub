// Offline, rule-based Latin -> Devanagari transliteration. No city database.
// City names are converted by *sound*. English spelling is irregular, so the
// output is an approximation meant to be readable \u2014 not authoritative.
// Same export name (`hindiCity`) as before, so nothing that imports it changes.

// Vowels: token -> [independent form, matra form]  ('' matra = inherent 'a')
const VOWELS = {
  "aa": ["\u0906", "\u093e"], "ai": ["\u0910", "\u0948"], "au": ["\u0914", "\u094c"], "ou": ["\u0914", "\u094c"],
  "ee": ["\u0908", "\u0940"], "ii": ["\u0908", "\u0940"], "oo": ["\u090a", "\u0942"], "uu": ["\u090a", "\u0942"],
  "a": ["\u0905", ""], "i": ["\u0907", "\u093f"], "u": ["\u0909", "\u0941"], "e": ["\u090f", "\u0947"], "o": ["\u0913", "\u094b"],
};

// Consonants (longest tokens first matter; sorting handles that)
const CONS = {
  "chh": "\u091b",
  "kh": "\u0916", "gh": "\u0918", "ch": "\u091a", "jh": "\u091d", "th": "\u0925", "dh": "\u0927",
  "ph": "\u092b", "bh": "\u092d", "sh": "\u0936", "ck": "\u0915", "wh": "\u0935",
  "k": "\u0915", "q": "\u0915", "c": "\u0915", "g": "\u0917", "j": "\u091c",
  "t": "\u091f", "d": "\u0921", "n": "\u0928", "p": "\u092a", "f": "\u092b", "b": "\u092c", "m": "\u092e",
  "y": "\u092f", "r": "\u0930", "l": "\u0932", "v": "\u0935", "w": "\u0935", "s": "\u0938", "h": "\u0939",
  "z": "\u091c\u093c", "x": "\u0915\u094d\u0938",
};

const ALL = [...Object.keys(CONS), ...Object.keys(VOWELS)].sort((a, b) => b.length - a.length);

function isVowelTok(t) { return Object.prototype.hasOwnProperty.call(VOWELS, t); }

function translitWord(word) {
  let out = "";
  let i = 0;
  let prevCons = false; // a consonant carrying an unspent inherent 'a'
  while (i < word.length) {
    let tok = null;
    for (const t of ALL) { if (word.startsWith(t, i)) { tok = t; break; } }
    if (!tok) { out += word[i]; i += 1; prevCons = false; continue; }
    if (isVowelTok(tok)) {
      const [ind, matra] = VOWELS[tok];
      out += prevCons ? matra : ind;
      prevCons = false;
    } else {
      // nasal before another consonant -> anusvara (\u092e\u0941\u0902\u092c\u0908, \u0907\u0902\u0926\u094c\u0930 style)
      const rest = word.slice(i + tok.length);
      const nextIsCons = rest && ALL.some(t => !isVowelTok(t) && rest.startsWith(t));
      if ((tok === "n" || tok === "m") && !prevCons && nextIsCons && out) {
        out += "\u0902";
      } else {
        if (prevCons) out += "\u094d"; // cluster: suppress previous inherent 'a'
        out += CONS[tok];
        prevCons = true;
      }
    }
    i += tok.length;
  }
  return out;
}

export function hindiCity(name) {
  if (!name) return "";
  const s = String(name).trim().toLowerCase();
  if (!s) return "";
  // transliterate each whitespace-separated chunk, keep separators
  return s.split(/(\s+)/).map(part => /\s+/.test(part) ? part : translitWord(part)).join("");
}

export default hindiCity;
