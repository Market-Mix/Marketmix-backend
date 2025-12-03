// Minimal token helper. Adapt to your auth implementation.
// This example assumes you store the JWT in localStorage under 'token'.

export default function getToken(){
  // e.g. localStorage.getItem('token') or from cookies
  const t = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
  return t || '';
}
