require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const otpGenerator = require('otp-generator');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

const app = express();

// ===== Constants =====
const PORT = process.env.PORT || 3002;
const HOST = '0.0.0.0'; // Required for Render
const OTP_FILE = process.env.RENDER 
  ? path.join('/var/data', 'otp_store.json') // Persistent storage on Render
  : 'otp_store.json';

// ===== OTP Storage =====
let otpStorage = new Map();

// Initialize persistent storage directory on Render
if (process.env.RENDER && !fs.existsSync('/var/data')) {
  fs.mkdirSync('/var/data', { recursive: true });
}

// Load OTPs on startup
const loadOtps = () => {
  try {
    if (fs.existsSync(OTP_FILE)) {
      const storedOtps = JSON.parse(fs.readFileSync(OTP_FILE));
      otpStorage = new Map(storedOtps);
      console.log(`Loaded ${otpStorage.size} OTPs from storage`);
    }
  } catch (err) {
    console.error('Error loading OTP storage:', err);
  }
};

loadOtps();

// ===== Middleware =====
app.use(cors({
  origin: process.env.FRONTEND_URL 
    ? process.env.FRONTEND_URL.split(',') 
    : 'http://localhost:3000',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

app.use(express.json({
  limit: '10kb',
  verify: (req, res, buf) => {
    try {
      JSON.parse(buf.toString('utf8'));
    } catch (e) {
      console.error('Invalid JSON:', buf.toString('utf8'));
      throw new Error('Invalid JSON format');
    }
  },
  strict: true
}));

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ===== Email Setup =====
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  },
  tls: {
    rejectUnauthorized: process.env.NODE_ENV === 'production'
  }
});

// ===== Routes =====
const router = express.Router();

// Health Check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// OTP Endpoints
router.post('/send-otp', async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    const otp = otpGenerator.generate(6, {
      digits: true,
      lowerCaseAlphabets: false,
      upperCaseAlphabets: false,
      specialChars: false
    });

    const otpData = { 
      otp, 
      expires: Date.now() + 300000,
      generatedAt: new Date().toISOString()
    };
    
    otpStorage.set(email, otpData);
    
    // Async file write for better performance
    fs.writeFile(OTP_FILE, JSON.stringify([...otpStorage]), (err) => {
      if (err) console.error('OTP save error:', err);
    });

    if (process.env.EMAIL_USER) {
      await transporter.sendMail({
        from: `"DeChat App" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: 'Your OTP Code',
        text: `Your OTP is: ${otp}`,
        html: `<b>${otp}</b>`
      });
    }

    res.json({ 
      success: true,
      debug: process.env.NODE_ENV !== 'production' ? { otp } : undefined
    });

  } catch (error) {
    console.error('OTP Error:', error);
    res.status(500).json({ 
      error: 'Failed to send OTP',
      ...(process.env.NODE_ENV !== 'production' && { details: error.message })
    });
  }
});

router.post('/verify-otp', (req, res) => {
  try {
    const { email, otp } = req.body;
    
    if (!otpStorage.has(email)) {
      return res.status(400).json({ error: 'OTP expired or not requested' });
    }

    const stored = otpStorage.get(email);
    
    if (Date.now() > stored.expires) {
      otpStorage.delete(email);
      fs.writeFile(OTP_FILE, JSON.stringify([...otpStorage]), () => {});
      return res.status(400).json({ error: 'OTP expired' });
    }

    if (stored.otp !== otp) {
      return res.status(400).json({ error: 'Invalid OTP' });
    }

    otpStorage.delete(email);
    fs.writeFile(OTP_FILE, JSON.stringify([...otpStorage]), () => {});
    res.json({ success: true });
  } catch (error) {
    console.error('Verify Error:', error);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// Mount router
app.use('/api/auth', router);

// Error Handling
app.use((err, req, res, next) => {
  console.error('Server Error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack })
  });
});

// ===== Server Startup =====
const server = app.listen(PORT, HOST, () => {
  console.log(`
███████╗ ██████╗ ██████╗  ██████╗ ██████╗ 
██╔════╝██╔═══██╗██╔══██╗██╔═══██╗██╔══██╗
█████╗  ██║   ██║██████╔╝██║   ██║██████╔╝
██╔══╝  ██║   ██║██╔══██╗██║   ██║██╔═══╝ 
██║     ╚██████╔╝██║  ██║╚██████╔╝██║     
╚═╝      ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚═╝     
                                          
🚀 Server running on http://${HOST}:${PORT}

📋 Available Endpoints:
  POST   /api/auth/send-otp
  POST   /api/auth/verify-otp
  GET    /health

🔧 Environment: ${process.env.NODE_ENV || 'development'}
✉️  Email: ${process.env.EMAIL_USER ? 'Configured' : 'Not configured'}
`);
});

// Handle shutdown gracefully
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});