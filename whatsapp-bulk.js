import dotenv from 'dotenv';
import express from "express";
import fs from "fs";
import { unlink, writeFile } from "fs/promises";
import http from "http";
import { DisconnectReason, makeWASocket, useMultiFileAuthState } from "maher-zubair-baileys";
import multer from "multer";
import nodemailer from "nodemailer";
import path from "path";
import qrcode from "qrcode";
import { Server as SocketIOServer } from "socket.io";
import XLSX from "xlsx";
import { bulkEmailConfig } from './config/bulk-email-config.js';
dotenv.config();

// Initialize Express and Socket.IO
const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: "*" }
});

// Email configuration
const emailConfig = {
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER || "vykanand@gmail.com",
    pass: process.env.EMAIL_PASS || "brqj ftms ktah jyqk",  // App password
  },
};

// Nodemailer transporter (reused for sending emails)
const transporter = nodemailer.createTransport(emailConfig);

// Constants
const PORT = process.env.PORT || 3001;
const AUTH_DIR = "auth_info_bulk";
const QR_DIR = path.join(process.cwd(), "public", "qr");
const UPLOAD_DIR = "uploads";

// WhatsApp client state
let globalSock = null;
let qrCodeGenerated = false;
let isConnected = false;
let reconnectAttempts = 0;
let isShuttingDown = false;
let isConnecting = false;
let qrGenerated = false;
let credsSavedThisSession = false;

// Message tracking
const messageStats = {
    sessionStart: new Date(),
    totalSent: 0,
    totalFailed: 0,
    lastMessageTime: null,
    dailyLimit: 1000, // Default limit, can be adjusted based on WhatsApp's policy
    dailyCounts: {},
    lastReset: new Date().toDateString(),
    updateDailyCount: function() {
        const today = new Date().toDateString();
        if (this.lastReset !== today) {
            this.dailyCounts = {};
            this.lastReset = today;
        }
        return this.dailyCounts[today] = (this.dailyCounts[today] || 0) + 1;
    },
    getRemainingDailyQuota: function() {
        const today = new Date().toDateString();
        return Math.max(0, this.dailyLimit - (this.dailyCounts[today] || 0));
    },
    isNearDailyLimit: function() {
        return this.getRemainingDailyQuota() < this.dailyLimit * 0.1; // 10% of limit remaining
    }
};

// Phone number validation utilities
const phoneUtils = {
    // Validate phone number format (E.164)
    validatePhoneNumber: (phone) => {
        if (!phone) return { valid: false, error: 'Phone number is required' };
        
        // Remove all non-digit characters
        const cleaned = phone.replace(/\D/g, '');
        
        // Check if it's a valid length (10-15 digits including country code)
        if (cleaned.length < 10 || cleaned.length > 15) {
            return { valid: false, error: 'Phone number must be 10-15 digits long' };
        }
        
        // Check if it's a valid number (basic check)
        if (!/^\d+$/.test(cleaned)) {
            return { valid: false, error: 'Invalid phone number format' };
        }
        
        return { valid: true, cleaned };
    },
    
    // Format number as WhatsApp ID
    formatAsJid: (phone) => {
        const { valid, cleaned, error } = phoneUtils.validatePhoneNumber(phone);
        if (!valid) return { error };
        
        // If already in JID format, return as is
        if (phone.endsWith('@s.whatsapp.net')) {
            return { jid: phone };
        }
        
        // Add country code if missing (default to 91 for India)
        let formattedNumber = cleaned;
        if (formattedNumber.length === 10) {
            formattedNumber = '91' + formattedNumber;
        } else if (formattedNumber.startsWith('0')) {
            formattedNumber = '91' + formattedNumber.substring(1);
        }
        
        return { jid: `${formattedNumber}@s.whatsapp.net` };
    }
};

// Helper: escape user-provided text for safe HTML
function escapeHtml(unsafe) {
  if (unsafe === undefined || unsafe === null) return '';
  return String(unsafe)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Send QR code via email
 */
async function sendQrCodeEmail(qr, req = null) {
  try {
    console.log("📧 Generating QR code for email...");
    const qrImage = await qrcode.toDataURL(qr);

    // Save QR code as temporary file
    const timestamp = Date.now();
    const qrFileName = `wa-qr-${timestamp}.png`;
    const qrFilePath = path.join(QR_DIR, qrFileName);
    const qrBuffer = Buffer.from(qrImage.split("base64,")[1], "base64");
    await writeFile(qrFilePath, qrBuffer);
    console.log("✅ QR code saved as temporary file");

    // Generate dynamic URL based on environment
    const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http';
    let host = `localhost:${PORT}`;
    
    // Use request headers to get actual host if available
    if (req && req.headers) {
      host = req.headers.host || host;
    } else if (process.env.RAILWAY_PUBLIC_DOMAIN) {
      host = process.env.RAILWAY_PUBLIC_DOMAIN;
    } else if (process.env.VERCEL_URL) {
      host = process.env.VERCEL_URL;
    }
    
    const qrUrl = `${protocol}://${host}/qr/${qrFileName}`;
    
    console.log(`🔗 QR Code URL: ${qrUrl}`);
    console.log(`📱 Scan this QR code: ${qrUrl}`);

    console.log("✅ QR code generated, creating email transporter...");
    const transporter = nodemailer.createTransport(emailConfig);

    console.log(`📧 Sending email to: ${emailConfig.auth.user}`);
    await transporter.sendMail({
      from: emailConfig.auth.user,
      to: emailConfig.auth.user, // Sending to self
      subject: "WhatsApp Bulk Bot - New Login QR Code",
      html: `
        <h2>WhatsApp Bulk Bot - New Login Required</h2>
        <p>A new login QR code has been generated for your WhatsApp Bulk Bot.</p>
        
        <div style="background-color: #f0f9ff; border-left: 4px solid #3b82f6; padding: 16px; margin: 20px 0;">
          <p style="margin: 0 0 12px 0;"><strong>Quick Access Link:</strong></p>
          <a href="${qrUrl}" style="display: inline-block; background-color: #3b82f6; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: bold;">${qrUrl}</a>
          <p style="margin: 12px 0 0 0; font-size: 14px; color: #666;">Click this link to view and scan the QR code directly in your browser.</p>
        </div>
        
        <p><strong>Option 1:</strong> Scan the attached QR code with your phone</p>
        <p><strong>Option 2:</strong> Click the link above to view the QR code in your browser and scan it</p>
        
        <p style="color: #666; font-size: 12px; margin-top: 20px;">This is an automated message. Please do not reply.</p>
      `,
      attachments: [
        {
          filename: "whatsapp-qr-code.png",
          content: qrImage.split("base64,")[1],
          encoding: "base64",
        },
      ],
    });
    console.log("✅ QR code sent successfully to email");
    
    return qrUrl;
  } catch (error) {
    console.error("❌ Error sending QR code email:", error.message);
    console.error("❌ Full error details:", error);
    console.log("💡 Tip: Check if Gmail app password is correct and less secure apps are enabled");
    return null;
  }
}

// Ensure directories exist
fs.mkdirSync(QR_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Middleware
app.use(express.json());
app.use(express.static(path.join(process.cwd(), "public")));

// Configure multer for file uploads using memory storage to avoid corruption
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB limit
  }
});

// WhatsApp connection configuration
const SOCKET_CONFIG = {
  printQRInTerminal: false,
  browser: ["Chrome", "Windows", "10"],
  version: [2, 2429, 7],
  connectTimeoutMs: 120000,
  qrTimeout: 120000,
  // Increase default query timeout to reduce transient 'Timed Out' errors
  defaultQueryTimeoutMs: 300000,
  retryRequestDelayMs: 3000,
  syncFullHistory: false,
  downloadHistory: false,
  markOnlineOnConnect: false,
  transactionOpts: {
    maxCommitRetries: 3,
    delayBetweenTriesMs: 5000,
  },
};

/**
 * Connect to WhatsApp with improved connection handling
 */
async function connectToWhatsApp() {
  // Prevent multiple simultaneous connection attempts
  if (isConnecting) {
    console.log("Connection attempt already in progress, skipping");
    return;
  }

  isConnecting = true;
  console.log('🔌 Initializing WhatsApp connection...');

  try {
    // Clean up existing connection if any
    if (globalSock) {
      console.log("Cleaning up existing connection...");
      try {
        globalSock.ev.removeAllListeners();
        if (globalSock.ws) {
          globalSock.ws.close();
        }
      } catch (err) {
        console.error("Error cleaning up previous connection:", err);
      } finally {
        globalSock = null;
      }
    }

    // Reset session tracking flags
    credsSavedThisSession = false;

    // Initialize auth state
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    // Create socket with configuration
    const sock = makeWASocket({
      auth: state,
      ...SOCKET_CONFIG
    });

    globalSock = sock;

    // Handle connection updates
    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const errorMessage =
          lastDisconnect?.error?.output?.payload?.message || "Unknown error";

        console.log(
          "Connection closed due to:",
          errorMessage,
          "Status code:",
          statusCode
        );

        if (
          statusCode === DisconnectReason.loggedOut ||
          errorMessage.includes("invalid") ||
          errorMessage.includes("expired") ||
          errorMessage.includes("conflict")
        ) {
          console.log(
            "Session expired or invalid. Will need new QR code on reconnection."
          );
          // Reset QR flag to generate new QR on next connection
          qrGenerated = false;
          credsSavedThisSession = false;

          // Auto-delete auth directory to force fresh QR code
          try {
            if (fs.existsSync(AUTH_DIR)) {
              console.log("🗑️ Deleting auth directory due to logout...");
              fs.rmSync(AUTH_DIR, { recursive: true, force: true });
              console.log("✅ Auth directory deleted successfully");
            }
          } catch (error) {
            console.error("❌ Error deleting auth directory:", error.message);
          }

          // Reconnect to generate new QR code and send via email
          console.log("🔄 Reconnecting to generate new QR code...");
          isConnected = false;
          isConnecting = false;
          setTimeout(connectToWhatsApp, 5000);
          return;
        }

        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        if (shouldReconnect) {
          console.log("Attempting to reconnect in 5 seconds...");
          isConnected = false;
          isConnecting = false;
          setTimeout(connectToWhatsApp, 5000);
        } else {
          console.log("Not reconnecting - user logged out");
          isConnected = false;
          isConnecting = false;
        }
      }

      // Handle QR code generation
      if (qr && !qrGenerated) {
        qrGenerated = true;
        const qrUrl = await sendQrCodeEmail(qr);
        console.log("🔄 QR Code generated - check your email or terminal");
        
        // Emit QR code URL to connected clients
        if (qrUrl) {
          io.emit('qr', { qr: qrUrl });
        }
      }

      if (connection === "open") {
        isConnected = true;
        isConnecting = false;
        qrGenerated = false;
        console.log("✅ Connection established successfully!");
      }
    });

    // Handle credentials update
    sock.ev.on("creds.update", saveCreds);

  } catch (error) {
    console.error("Error in connection setup:", error);
    isConnected = false;
    isConnecting = false;
    
    // Attempt to reconnect after error
    console.log("Attempting to reconnect after error in 10 seconds...");
    setTimeout(connectToWhatsApp, 10000);
  }
}

// API Routes

// Debug endpoint: show resolved bulk email provider config (values masked)
app.get('/api/debug-email-config', (req, res) => {
  try {
    const providerKey = process.env.BULK_EMAIL_PROVIDER || (typeof bulkEmailConfig !== 'undefined' && (bulkEmailConfig.selected || bulkEmailConfig.default)) || 'gmail';
    const provider = (typeof bulkEmailConfig !== 'undefined' && bulkEmailConfig.providers && bulkEmailConfig.providers[providerKey]) || null;

    const mask = (v) => {
      if (!v) return null;
      const s = String(v);
      if (s.length <= 4) return '****';
      return s.slice(0, 2) + '***' + s.slice(-1);
    };

    const result = {
      env: {
        BULK_EMAIL_PROVIDER: process.env.BULK_EMAIL_PROVIDER || null,
        BULK_GMAIL_USER: process.env.BULK_GMAIL_USER || null,
        BULK_GMAIL_PASS: process.env.BULK_GMAIL_PASS ? mask(process.env.BULK_GMAIL_PASS) : null,
        ZOHO_USER: process.env.ZOHO_USER || null,
        ZOHO_PASS: process.env.ZOHO_PASS ? mask(process.env.ZOHO_PASS) : null,
        OUTLOOK_USER: process.env.OUTLOOK_USER || null,
        OUTLOOK_PASS: process.env.OUTLOOK_PASS ? mask(process.env.OUTLOOK_PASS) : null,
        EMAIL_USER: process.env.EMAIL_USER || null,
        EMAIL_PASS: process.env.EMAIL_PASS ? mask(process.env.EMAIL_PASS) : null
      },
      resolvedProviderKey: providerKey,
      providerConfigPresent: !!provider,
      provider: provider ? {
        host: provider.host || provider.service || null,
        port: provider.port || null,
        secure: provider.secure === true,
        auth: provider.auth ? { user: provider.auth.user || null, pass: provider.auth.pass ? mask(provider.auth.pass) : null } : null
      } : null
    };

    return res.json({ success: true, config: result });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Get connection status
 */
app.get('/api/status', (req, res) => {
    res.json({
        connected: isConnected,
        connecting: isConnecting,
        qrGenerated: qrGenerated,
        timestamp: new Date().toISOString()
    });
});

/**
 * Request new WhatsApp connection (generates QR code)
 */
app.post('/api/connect', async (req, res) => {
  try {
    console.log('🔗 Manual connection request received');
    
    if (isConnecting) {
      return res.status(400).json({
        success: false,
        error: 'Connection already in progress'
      });
    }
    
    if (isConnected) {
      return res.status(400).json({
        success: false,
        error: 'Already connected to WhatsApp'
      });
    }
    
    // Delete auth directory to force fresh QR code
    try {
      if (fs.existsSync(AUTH_DIR)) {
        console.log('🗑️ Deleting auth directory for fresh connection...');
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        console.log('✅ Auth directory deleted');
      }
    } catch (error) {
      console.error('❌ Error deleting auth directory:', error.message);
    }
    
    // Reset QR flag
    qrGenerated = false;
    credsSavedThisSession = false;
    
    // Start connection
    connectToWhatsApp();
    
    res.json({
      success: true,
      message: 'Connection initiated. QR code will be generated and sent via email.',
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Error in /api/connect:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to initiate connection',
      message: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * Disconnect and logout from WhatsApp
 */
app.post('/api/disconnect', async (req, res) => {
  try {
    console.log('🔌 Manual disconnect request received');
    
    if (!isConnected && !globalSock) {
      return res.status(400).json({
        success: false,
        error: 'Not connected to WhatsApp'
      });
    }
    
    // Close WhatsApp connection
    if (globalSock) {
      try {
        await globalSock.end();
        console.log('✅ Connection ended');
      } catch (endError) {
        console.error('Error during connection end:', endError.message);
      }
      
      try {
        globalSock.ev.removeAllListeners();
        if (globalSock.ws) {
          globalSock.ws.close();
        }
      } catch (err) {
        console.error('Error cleaning up connection:', err);
      }
      
      globalSock = null;
    }
    
    // Delete auth directory
    try {
      if (fs.existsSync(AUTH_DIR)) {
        console.log('🗑️ Deleting auth directory...');
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        console.log('✅ Auth directory deleted');
      }
    } catch (error) {
      console.error('❌ Error deleting auth directory:', error.message);
    }
    
    // Reset flags
    isConnected = false;
    isConnecting = false;
    qrGenerated = false;
    credsSavedThisSession = false;
    
    res.json({
      success: true,
      message: 'Successfully disconnected from WhatsApp',
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Error in /api/disconnect:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to disconnect',
      message: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * Health check endpoint
 */
app.get("/api/health", (req, res) => {
  res.json({ 
    status: "ok", 
    connected: isConnected, 
    qr: isConnected ? null : `http://localhost:${PORT}/qr/qr-${Date.now()}.png`
  });
});

/**
 * Send a single message
 */
app.post("/api/send", upload.single('media'), async (req, res) => {
  try {
    const { number, message, caption } = req.body;
    const mediaFile = req.file;
    
    console.log('Received send request:', { 
      number, 
      message: message?.substring(0, 50) + (message?.length > 50 ? '...' : ''),
      hasMedia: !!mediaFile,
      mediaName: mediaFile?.originalname
    });
    
    // Basic validation
    if (!number) {
      return res.status(400).json({ 
        success: false, 
        error: 'Phone number is required'
      });
    }
    
    if (!mediaFile && !message) {
      return res.status(400).json({ 
        success: false, 
        error: 'Either message or media file is required'
      });
    }
    
    // Check WhatsApp connection
    if (!globalSock || !isConnected) {
      return res.status(503).json({ 
        success: false, 
        error: 'WhatsApp not connected. Please wait for the connection to be established.',
        connected: isConnected,
        hasSocket: !!globalSock
      });
    }

    // Check daily message limit
    const remainingQuota = messageStats.getRemainingDailyQuota();
    if (remainingQuota <= 0) {
      return res.status(429).json({
        success: false,
        error: 'Daily message limit reached',
        limit: messageStats.dailyLimit,
        reset: messageStats.lastReset
      });
    }

    // Validate and format phone number
    const validation = phoneUtils.validatePhoneNumber(number);
    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        error: validation.error,
        number: number
      });
    }

    // Format as WhatsApp JID
    const { jid, error: jidError } = phoneUtils.formatAsJid(number);
    if (jidError) {
      return res.status(400).json({
        success: false,
        error: jidError,
        number: number
      });
    }

    try {
      console.log('Sending message to JID:', jid);
      
      // Update message stats before sending
      messageStats.updateDailyCount();
      messageStats.totalSent++;
      messageStats.lastMessageTime = new Date();
      
      let messageOptions = {};
      
      if (mediaFile) {
        // Determine media type
        const ext = mediaFile.originalname.split('.').pop().toLowerCase();
        const imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
        const videoExtensions = ['mp4', 'mov', 'avi'];
        const documentExtensions = ['pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx'];

        // Explicit MIME type map — browser-reported MIME types can be wrong (e.g.
        // application/octet-stream for PDF), which causes WhatsApp to receive the
        // file with the wrong type and refuse to open it.
        const mimeTypeMap = {
          pdf:  'application/pdf',
          doc:  'application/msword',
          docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          ppt:  'application/vnd.ms-powerpoint',
          pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          xls:  'application/vnd.ms-excel',
          xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          jpg:  'image/jpeg',
          jpeg: 'image/jpeg',
          png:  'image/png',
          gif:  'image/gif',
          webp: 'image/webp',
          mp4:  'video/mp4',
          mov:  'video/quicktime',
          avi:  'video/x-msvideo',
        };
        const resolvedMimeType = mimeTypeMap[ext] || mediaFile.mimetype || 'application/octet-stream';
        
        // Create a fresh Buffer copy to ensure binary integrity
        const mediaBuffer = Buffer.from(mediaFile.buffer);
        
        if (imageExtensions.includes(ext)) {
          messageOptions = {
            image: mediaBuffer,
            mimetype: resolvedMimeType,
            caption: caption || message || ''
          };
        } else if (videoExtensions.includes(ext)) {
          messageOptions = {
            video: mediaBuffer,
            mimetype: resolvedMimeType,
            caption: caption || message || ''
          };
        } else if (documentExtensions.includes(ext)) {
          messageOptions = {
            document: mediaBuffer,
            mimetype: resolvedMimeType,
            caption: caption || message || '',
            fileName: mediaFile.originalname
          };
        } else {
          // Treat as generic document
          messageOptions = {
            document: mediaBuffer,
            mimetype: resolvedMimeType,
            caption: caption || message || '',
            fileName: mediaFile.originalname
          };
        }
      } else {
        // Text-only message
        messageOptions = {
          text: String(message)
        };
      }
      
      // Send the message
      await globalSock.sendMessage(jid, messageOptions);
      
      console.log('Message sent successfully to:', jid);
      
      // Emit stats update to connected clients
      io.emit('statsUpdate', {
        totalSent: messageStats.totalSent,
        totalFailed: messageStats.totalFailed,
        dailyLimit: messageStats.dailyLimit,
        dailyUsed: messageStats.dailyCounts[messageStats.lastReset] || 0,
        remainingQuota: messageStats.getRemainingDailyQuota(),
        isNearLimit: messageStats.isNearDailyLimit()
      });
      
      res.json({ 
        success: true, 
        message: mediaFile ? 'Media message sent successfully' : 'Message sent successfully',
        jid,
        originalNumber: number,
        timestamp: new Date().toISOString(),
        stats: {
          totalSent: messageStats.totalSent,
          dailyUsed: messageStats.dailyCounts[messageStats.lastReset] || 0,
          remainingQuota: messageStats.getRemainingDailyQuota(),
          isNearLimit: messageStats.isNearDailyLimit()
        }
      });
      
    } catch (sendError) {
      console.error('Error in message sending:', {
        error: sendError.message,
        stack: sendError.stack,
        number,
        originalError: sendError
      });
      
      // Check for specific WhatsApp Web errors
      let errorMessage = sendError.message || 'Failed to send message';
      let errorCode = 500;
      
      // Handle specific WhatsApp Web errors
      if (errorMessage.includes('not-authorized') || errorMessage.includes('not logged in')) {
        errorCode = 401;
        errorMessage = 'WhatsApp session expired. Please re-authenticate.';
      } else if (errorMessage.includes('not-authorized')) {
        errorCode = 403;
        errorMessage = 'Not authorized to send messages. The phone number may be invalid or not registered on WhatsApp.';
      }
      
      res.status(errorCode).json({
        success: false,
        error: errorMessage,
        details: process.env.NODE_ENV === 'development' ? {
          originalError: sendError.message,
          stack: sendError.stack
        } : undefined,
        number,
        timestamp: new Date().toISOString()
      });
    }
    
  } catch (error) {
    console.error('Unexpected error in /api/send:', {
      error: error.message,
      stack: error.stack,
      body: req.body
    });
    
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error',
      message: process.env.NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Send message with media attachment
 */
app.post("/api/send-media", upload.single('media'), async (req, res) => {
  try {
    const { number, message, caption } = req.body;
    const mediaFile = req.file;
    
    console.log('Received send-media request:', { 
      number, 
      caption: caption?.substring(0, 50) + (caption?.length > 50 ? '...' : ''),
      hasMedia: !!mediaFile,
      mediaName: mediaFile?.originalname
    });
    
    // Basic validation
    if (!number) {
      return res.status(400).json({ 
        success: false, 
        error: 'Phone number is required'
      });
    }
    
    if (!mediaFile && !caption) {
      return res.status(400).json({ 
        success: false, 
        error: 'Either media file or caption is required'
      });
    }
    
    // Check WhatsApp connection
    if (!globalSock || !isConnected) {
      return res.status(503).json({ 
        success: false, 
        error: 'WhatsApp not connected. Please wait for the connection to be established.',
        connected: isConnected,
        hasSocket: !!globalSock
      });
    }

    // Check daily message limit
    const remainingQuota = messageStats.getRemainingDailyQuota();
    if (remainingQuota <= 0) {
      return res.status(429).json({
        success: false,
        error: 'Daily message limit reached',
        limit: messageStats.dailyLimit,
        reset: messageStats.lastReset
      });
    }

    // Validate and format phone number
    const validation = phoneUtils.validatePhoneNumber(number);
    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        error: validation.error,
        number: number
      });
    }

    // Format as WhatsApp JID
    const { jid, error: jidError } = phoneUtils.formatAsJid(number);
    if (jidError) {
      return res.status(400).json({
        success: false,
        error: jidError,
        number: number
      });
    }

    try {
      console.log('Sending media message to JID:', jid);
      
      // Update message stats before sending
      messageStats.updateDailyCount();
      messageStats.totalSent++;
      messageStats.lastMessageTime = new Date();
      
      let messageOptions = {};
      
      if (mediaFile) {
        // Determine media type
        const ext = mediaFile.originalname.split('.').pop().toLowerCase();
        const imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
        const videoExtensions = ['mp4', 'mov', 'avi'];
        const documentExtensions = ['pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx'];
        
        // Use memory buffer directly to avoid corruption
        const mediaBuffer = mediaFile.buffer;
        
        if (imageExtensions.includes(ext)) {
          messageOptions = {
            image: mediaBuffer,
            caption: caption || message || ''
          };
        } else if (videoExtensions.includes(ext)) {
          messageOptions = {
            video: mediaBuffer,
            caption: caption || message || ''
          };
        } else if (documentExtensions.includes(ext)) {
          messageOptions = {
            document: mediaBuffer,
            mimetype: mediaFile.mimetype,
            caption: caption || message || '',
            fileName: mediaFile.originalname
          };
        } else {
          // Treat as generic document
          messageOptions = {
            document: mediaBuffer,
            mimetype: mediaFile.mimetype || 'application/octet-stream',
            caption: caption || message || '',
            fileName: mediaFile.originalname
          };
        }
      } else if (caption) {
        // Text-only message with caption
        messageOptions = {
          text: caption
        };
      }
      
      // Send the message
      await globalSock.sendMessage(jid, messageOptions);
      
      console.log('Media message sent successfully to:', jid);
      
      // Clean up uploaded file
      if (mediaFile) {
        await unlink(mediaFile.path);
      }
      
      // Emit stats update to connected clients
      io.emit('statsUpdate', {
        totalSent: messageStats.totalSent,
        totalFailed: messageStats.totalFailed,
        dailyLimit: messageStats.dailyLimit,
        dailyUsed: messageStats.dailyCounts[messageStats.lastReset] || 0,
        remainingQuota: messageStats.getRemainingDailyQuota(),
        isNearLimit: messageStats.isNearDailyLimit()
      });
      
      res.json({ 
        success: true, 
        message: 'Media message sent successfully',
        jid,
        originalNumber: number,
        timestamp: new Date().toISOString(),
        stats: {
          totalSent: messageStats.totalSent,
          dailyUsed: messageStats.dailyCounts[messageStats.lastReset] || 0,
          remainingQuota: messageStats.getRemainingDailyQuota(),
          isNearLimit: messageStats.isNearDailyLimit()
        }
      });
      
    } catch (sendError) {
      console.error('Error in media message sending:', {
        error: sendError.message,
        stack: sendError.stack,
        number,
        originalError: sendError
      });
      
      // Clean up uploaded file on error
      if (mediaFile) {
        try {
          await unlink(mediaFile.path);
        } catch (cleanupError) {
          console.error('Error cleaning up file:', cleanupError);
        }
      }
      
      // Check for specific WhatsApp Web errors
      let errorMessage = sendError.message || 'Failed to send media message';
      let errorCode = 500;
      
      // Handle specific WhatsApp Web errors
      if (errorMessage.includes('not-authorized') || errorMessage.includes('not logged in')) {
        errorCode = 401;
        errorMessage = 'WhatsApp session expired. Please re-authenticate.';
      } else if (errorMessage.includes('not-authorized')) {
        errorCode = 403;
        errorMessage = 'Not authorized to send messages. The phone number may be invalid or not registered on WhatsApp.';
      }
      
      res.status(errorCode).json({
        success: false,
        error: errorMessage,
        details: process.env.NODE_ENV === 'development' ? {
          originalError: sendError.message,
          stack: sendError.stack
        } : undefined,
        number,
        timestamp: new Date().toISOString()
      });
    }
    
  } catch (error) {
    console.error('Unexpected error in /api/send-media:', {
      error: error.message,
      stack: error.stack,
      body: req.body
    });
    
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error',
      message: process.env.NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Send a single email (used by client when channel=email)
 */
app.post('/api/send-email', upload.single('media'), async (req, res) => {
  try {
    const { to, subject, message } = req.body;
    const file = req.file;

    if (!to) {
      return res.status(400).json({ success: false, error: 'Recipient (to) is required' });
    }

    // Determine bulk email provider to use. Guard in case `bulkEmailConfig` is not available (old process)
    const providerKey = process.env.BULK_EMAIL_PROVIDER || (typeof bulkEmailConfig !== 'undefined' && (bulkEmailConfig.selected || bulkEmailConfig.default)) || 'gmail';
    const providerConfig = (typeof bulkEmailConfig !== 'undefined' && bulkEmailConfig.providers && bulkEmailConfig.providers[providerKey]) || null;
    if (!providerConfig) {
      // Fallback: use the top-level `emailConfig` (keeps existing Gmail behavior)
      console.warn('Bulk email provider config missing or unknown, falling back to emailConfig');
      const fallbackTransporter = nodemailer.createTransport(emailConfig);
      const safeMessageFallback = escapeHtml(typeof message === 'string' ? message : String(message || ''));
      const htmlBodyFallback = `<div style="font-family: Calibri, 'Segoe UI', Arial, sans-serif; font-size:10pt; white-space:pre-wrap; color:#000;">${safeMessageFallback}</div>`;
      const info = await fallbackTransporter.sendMail({
        from: emailConfig.auth.user,
        to: String(to),
        subject: subject || 'Message from Appsthink Whatsapp pro',
          subject: subject || 'Message from Appsthink 360',
        text: typeof message === 'string' ? message : String(message || ''),
        html: htmlBodyFallback,
        attachments: file ? [{ filename: file.originalname, content: file.buffer, contentType: file.mimetype }] : []
      });
      console.log('Bulk email sent via fallback transporter messageId:', info.messageId, 'to', to);
      return res.json({ success: true, message: 'Email sent (fallback)', info, provider: 'fallback' });
    }

    // Build mail options; prefer provider auth user, fall back to main emailConfig
    const fromAddress = (providerConfig.auth && providerConfig.auth.user) || emailConfig.auth.user;
    const safeMessage = escapeHtml(typeof message === 'string' ? message : String(message || ''));
    const htmlBody = `<div style="font-family: Calibri, 'Segoe UI', Arial, sans-serif; font-size:10pt; white-space:pre-wrap; color:#000;">${safeMessage}</div>`;
    const mailOptions = {
      from: fromAddress,
      to: String(to),
      subject: subject || 'Message from Appsthink Whatsapp pro',
        subject: subject || 'Message from Appsthink 360',
      text: typeof message === 'string' ? message : String(message || ''),
      html: htmlBody,
      attachments: []
    };

    if (file) {
      mailOptions.attachments.push({ filename: file.originalname, content: file.buffer, contentType: file.mimetype });
    }

    // Create transporter for the selected provider (keeps QR-email transporter unchanged)
    const bulkTransporter = nodemailer.createTransport(providerConfig);

    const info = await bulkTransporter.sendMail(mailOptions);
    console.log('Bulk email sent via', providerKey, 'messageId:', info.messageId, 'to', to);
    return res.json({ success: true, message: 'Email sent', info, provider: providerKey });
  } catch (error) {
    console.error('Error in /api/send-email:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Upload and process Excel file with numbers and messages
 */
app.post("/api/send-bulk", upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ 
        success: false, 
        error: "No file uploaded" 
      });
    }

    // Read the uploaded file from memory buffer (multer uses memoryStorage)
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    
    // Get headers and data separately
    const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
    const headers = jsonData[0];
    const rows = jsonData.slice(1);

    if (!globalSock || !isConnected) {
      return res.status(503).json({ 
        success: false, 
        error: "Not connected to WhatsApp" 
      });
    }

    // Find phone and message column indices
    const phoneColumnIndex = headers.findIndex(header => 
      header && ['phone', 'number', 'mobile', 'contact', 'phonenumber', 'phone_number', 'contactno']
        .includes(String(header).toLowerCase().trim())
    );
    
    const messageColumnIndex = headers.findIndex(header => 
      header && ['message', 'msg', 'text', 'content']
        .includes(String(header).toLowerCase().trim())
    );

    if (phoneColumnIndex === -1) {
      return res.status(400).json({
        success: false,
        error: "Could not find phone number column in the file. Please ensure your file has a column named 'phone' or 'number'."
      });
    }

    if (messageColumnIndex === -1) {
      return res.status(400).json({
        success: false,
        error: "Could not find message column in the file. Please ensure your file has a column named 'message' or 'text'."
      });
    }

    const results = [];
    let successCount = 0;
    let failCount = 0;

    // Process each row
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
        // Get phone number and message based on column indices
        const number = row[phoneColumnIndex];
        let message = row[messageColumnIndex];
        
        // If message is a template with variables, replace them
        if (typeof message === 'string') {
          headers.forEach((header, idx) => {
            if (header && row[idx] !== undefined && row[idx] !== null) {
              const headerStr = String(header).toLowerCase().trim();
              if (headerStr) {
                const placeholder = `{${headerStr}}`;
                message = message.replace(new RegExp(placeholder, 'g'), String(row[idx]));
              }
            }
          });
        }

        if (!number) {
          results.push({
            index: i,
            success: false,
            error: "Missing phone number",
            row: i + 2 // +2 because of 0-based index and header row
          });
          failCount++;
          continue;
        }
        
        if (!message) {
          results.push({
            index: i,
            success: false,
            error: "Missing message content",
            row: i + 2
          });
          failCount++;
          continue;
        }
        
        // Clean and validate phone number
        let phoneNumber = String(number).replace(/\D/g, ''); // Remove non-digit characters
        
        // If number starts with '0', remove it
        if (phoneNumber.startsWith('0')) {
          phoneNumber = phoneNumber.substring(1);
        }
        
        // If number starts with country code, keep it, otherwise add default country code (91 for India)
        if (!phoneNumber.startsWith('91') && phoneNumber.length === 10) {
          phoneNumber = '91' + phoneNumber;
        }
        
        // Validate phone number format
        if (phoneNumber.length < 10 || phoneNumber.length > 15) {
          results.push({
            index: i,
            success: false,
            error: `Invalid phone number length: ${phoneNumber}`,
            row: i + 2
          });
          failCount++;
          continue;
        }
        
        // Format as WhatsApp ID
        const jid = `${phoneNumber}@s.whatsapp.net`;
        
        // Send the message
        await globalSock.sendMessage(jid, { text: message });
        
        // Update stats
        messageStats.totalSent++;
        messageStats.updateDailyCount();
        messageStats.lastMessageTime = new Date();
        
        // Add to results
        results.push({
          index: i,
          success: true,
          phone: phoneNumber,
          row: i + 2
        });
        successCount++;
        
        // Add a small delay between messages to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));
        
      } catch (error) {
        console.error(`Error processing row ${i + 2}:`, error);
        results.push({
          index: i,
          success: false,
          error: error.message,
          row: i + 2
        });
        failCount++;
      }
    }

    return res.json({
      success: true,
      sent: successCount,
      failed: failCount,
      total: rows.length,
      results
    });
  } catch (error) {
    console.error("Error processing bulk send:", error);
    return res.status(500).json({
      success: false,
      error: error.message || "Failed to process bulk send"
    });
  }
});

// Serve QR codes
app.use("/qr", express.static(QR_DIR));

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({
    success: false,
    error: process.env.NODE_ENV === 'production' 
      ? 'Internal server error' 
      : err.message
  });
});

// Set up WebSocket connection
io.on('connection', (socket) => {
  console.log('Client connected');
  
  // Send current status to newly connected client
  socket.emit('status', { 
    status: isConnected ? 'connected' : 'disconnected',
    qr: isConnected ? null : `http://localhost:${PORT}/qr/qr-${Date.now()}.png`
  });
  
  socket.on('disconnect', () => {
    console.log('Client disconnected');
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🔗 Health check: http://localhost:${PORT}/api/health`);
  
  // Connect to WhatsApp
  connectToWhatsApp();
});

// Handle process termination
async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  console.log('\n🛑 Shutting down gracefully...');
  
  // Clean up the WhatsApp connection
  if (globalSock) {
    try {
      console.log('Closing WhatsApp connection...');
      await globalSock.ev.flush();
      if (globalSock.ws) {
        globalSock.ws.close();
      }
      globalSock = null;
    } catch (error) {
      console.error('Error during WhatsApp connection cleanup:', error);
    }
  }
  
  // Close HTTP server if it exists
  if (server) {
    server.close(() => {
      console.log('✅ Server closed');
      process.exit(0);
    });
    
    // Force exit after timeout
    setTimeout(() => {
      console.log('⚠️ Forcing shutdown...');
      process.exit(1);
    }, 5000);
  } else {
    process.exit(0);
  }
}

// Set up process event listeners
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't exit the process here, let the error be logged and continue running
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  shutdown().catch(err => {
    console.error('Error during shutdown after uncaught exception:', err);
    process.exit(1);
  });
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  shutdown().catch(err => {
    console.error('Error during shutdown after unhandled rejection:', err);
    process.exit(1);
  });
});

// Export for testing
// At the top of the file, add:
const isTest = process.env.NODE_ENV === 'test';
// At the bottom of the file, replace the if block with:
export const testExports = isTest ? {
  app, 
  server, 
  io, 
  connectToWhatsApp, 
  isConnected, 
  qrPath 
} : null;