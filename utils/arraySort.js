/**
 * Array sort utility - 1:1 port of PHP array_sort()
 * Sorts array of objects by a specified key
 */
function arraySort(array, key, order = 'asc') {
  return [...array].sort((a, b) => {
    const valA = a[key];
    const valB = b[key];
    if (valA < valB) return order === 'asc' ? -1 : 1;
    if (valA > valB) return order === 'asc' ? 1 : -1;
    return 0;
  });
}

module.exports = { arraySort };
