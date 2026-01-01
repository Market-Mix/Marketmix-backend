// CORS configuration
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5173', // Vite
  'http://localhost:5500', // Live Server
  'http://127.0.0.1:5500', // Live Server alternative
  'https://marketmix.vercel.app', // your correct frontend domain
  'https://marketmix-backend.onrender.com', // Your render backend
  process.env.CLIENT_URL
].filter(Boolean);

const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, Postman, etc.)
    if (!origin) return callback(null, true);

    // Allow explicitly configured origins
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    // Allow Vercel preview and production subdomains (e.g. *.vercel.app)
    try {
      const url = new URL(origin);
      const hostname = url.hostname;
      if (hostname && (hostname.endsWith('.vercel.app') || hostname === 'localhost')) {
        return callback(null, true);
      }
    } catch (e) {
      // If origin is not a valid URL, fall through to reject it
      console.log('CORS URL parse error:', e.message);
    }

    console.log('Blocked by CORS:', origin);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  optionsSuccessStatus: 200,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
};

module.exports = corsOptions;
