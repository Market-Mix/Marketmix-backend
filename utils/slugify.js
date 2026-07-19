// utils/slugify.js
function slugify(str = '') {
  return str.toString().toLowerCase().trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 40);
}

async function uniqueAccountSlug(db, base) {
  let slug = slugify(base) || 'seller';
  let i = 0;
  while (true) {
    const candidate = i === 0 ? slug : `${slug}${i}`;
    const r = await db.query('SELECT 1 FROM users WHERE account_slug = $1', [candidate]);
    if (!r.rows.length) return candidate;
    i++;
  }
}

module.exports = { slugify, uniqueAccountSlug };