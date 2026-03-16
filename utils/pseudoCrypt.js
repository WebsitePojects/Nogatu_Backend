/**
 * PseudoCrypt - 1:1 port of PHP PseudoCrypt class
 * Used for generating activation codes from sequential IDs
 * Uses base-62 encoding with golden ratio primes for pseudo-random distribution
 */

// BigInt versions of the golden primes and their modular multiplicative inverses
const GOLDEN_PRIMES = {
  1: 1n,
  2: 41n,
  3: 2377n,
  4: 147299n,
  5: 9132313n,
  6: 566201239n,
  7: 35104476161n,
  8: 2176477521929n,
  9: 134941606358731n,
  10: 8366379594239857n,
  11: 518715534842869223n,
};

const MMI_PRIMES = {
  1: 1n,
  2: 59n,
  3: 1677n,
  4: 187507n,
  5: 5952585n,
  6: 643566407n,
  7: 22071637057n,
  8: 294289236153n,
  9: 88879354792675n,
  10: 7275288500431249n,
  11: 280042546585394647n,
};

// ASCII: 0-9 (48-57), A-Z (65-90), a-z (97-122)
const CHARS62 = [
  48, 49, 50, 51, 52, 53, 54, 55, 56, 57,
  65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75,
  76, 77, 78, 79, 80, 81, 82, 83, 84, 85,
  86, 87, 88, 89, 90,
  97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110,
  111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 122,
];

class PseudoCrypt {
  static base62(int) {
    let bigInt = BigInt(int);
    let key = '';
    while (bigInt > 0n) {
      const mod = Number(bigInt % 62n);
      key += String.fromCharCode(CHARS62[mod]);
      bigInt = bigInt / 62n;
    }
    return key.split('').reverse().join('');
  }

  static hash(num, len = 5) {
    const bigNum = BigInt(num);
    const ceil = 62n ** BigInt(len);
    const prime = GOLDEN_PRIMES[len];
    const dec = (bigNum * prime) % ceil;
    const hashStr = PseudoCrypt.base62(dec);
    return hashStr.padStart(len, '0');
  }

  static unbase62(key) {
    let int = 0n;
    const chars = key.split('').reverse();
    for (let i = 0; i < chars.length; i++) {
      const charCode = chars[i].charCodeAt(0);
      const dec = CHARS62.indexOf(charCode);
      int += BigInt(dec) * (62n ** BigInt(i));
    }
    return int;
  }

  static unhash(hash) {
    const len = hash.length;
    const ceil = 62n ** BigInt(len);
    const mmi = MMI_PRIMES[len];
    const num = PseudoCrypt.unbase62(hash);
    const dec = (num * mmi) % ceil;
    return Number(dec);
  }
}

module.exports = PseudoCrypt;
