import express from "express";
import { makeWASocket, useMultiFileAuthState, DisconnectReason } from "maher-zubair-baileys";
import qrcode from "qrcode";
import { writeFile, unlink } from "fs/promises";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import multer from "multer";
import XLSX from "xlsx";
import http from "http";
import { Server as SocketIOServer } from "socket.io";
import nodemailer from "nodemailer";

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
    user: "vykanand@gmail.com",
    pass: "brqj ftms ktah jyqk",  // App password
  },
};

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

/**
 * Send QR code via email
 */
async function sendQrCodeEmail(qr) {
  try {
    const qrImage = await qrcode.toDataURL(qr);
    const transporter = nodemailer.createTransport(emailConfig);

    await transporter.sendMail({
      from: emailConfig.auth.user,
      to: emailConfig.auth.user, // Sending to self
      subject: "WhatsApp Bulk Bot - New Login QR Code",
      html: `
        <h2>WhatsApp Bulk Bot - New Login Required</h2>
        <p>A new login QR code has been generated for your WhatsApp Bulk Bot.</p>
        <p>Please scan the attached QR code with your phone to continue using the service.</p>
        <p>This is an automated message. Please do not reply.</p>
      `,
      attachments: [
        {
          filename: "whatsapp-qr-code.png",
          content: qrImage.split("base64,")[1],
          encoding: "base64",
        },
      ],
    });
    console.log("📧 QR code sent to email");
  } catch (error) {
    console.error("❌ Error sending QR code email:", error);
  }
}

// Ensure directories exist
fs.mkdirSync(QR_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Middleware
app.use(express.json());
app.use(express.static(path.join(process.cwd(), "public")));

// Configure multer for file uploads
const upload = multer({ dest: UPLOAD_DIR });

// WhatsApp connection configuration
const SOCKET_CONFIG = {
  printQRInTerminal: true,
  terminalWidth: 40,
  browser: ["Chrome", "Windows", "10"],
  version: [2, 2429, 7],
  connectTimeoutMs: 120000,
  qrTimeout: 60000,
  defaultQueryTimeoutMs: 120000,
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
          errorMessage.includes("expired")
        ) {
          console.log(
            "Session expired or invalid. Will need new QR code on reconnection."
          );
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
        await sendQrCodeEmail(qr);
        console.log("🔄 QR Code generated - check your email or terminal");
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
app.post("/api/send", async (req, res) => {
  try {
    const { number, message } = req.body;
    
    console.log('Received send request:', { number, message: message?.substring(0, 50) + (message?.length > 50 ? '...' : '') });
    
    // Basic validation
    if (!number || !message) {
      return res.status(400).json({ 
        success: false, 
        error: 'Phone number and message are required',
        received: { number: !!number, message: !!message }
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
      
      // Send the message
      await globalSock.sendMessage(jid, { 
        text: String(message) 
      });
      
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
        message: 'Message sent successfully',
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

    // Read the uploaded file
    const workbook = XLSX.readFile(req.file.path);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    
    // Get headers and data separately
    const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
    const headers = jsonData[0];
    const rows = jsonData.slice(1);

    // Clean up uploaded file
    await unlink(req.file.path);

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