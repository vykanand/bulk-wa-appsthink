# WhatsApp Bulk Sender

A standalone WhatsApp bulk message sender with a web interface. Send personalized messages to multiple contacts via Excel/CSV upload with rate limiting and session management.

## Features

- **Bulk Messaging**: Send messages to multiple contacts from Excel/CSV files
- **Random Delays**: Configurable base delay (20-60s) with jitter (±5-10s) between messages
- **Session Limits**: Maximum 100 messages per session to prevent spam
- **Daily Limits**: Configurable daily message limit (default 100)
- **Phone Validation**: Automatic phone number validation with country code support
- **Real-time Progress**: Live progress tracking with success/failure counts
- **Message Personalization**: Use template variables like `{name}`, `{phone}` for personalized messages
- **Activity Logging**: Detailed activity log for tracking all operations
- **QR Code Authentication**: WhatsApp Web QR code sent via email for easy login

## Installation

1. Navigate to the project directory:
   ```bash
   cd C:\dev\whatsapp-bulk-sender
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

## Configuration

### Email Configuration (for QR Code)
Edit the `emailConfig` object in `whatsapp-bulk.js` to use your own Gmail credentials:
```javascript
const emailConfig = {
  service: "gmail",
  auth: {
    user: "your-email@gmail.com",
    pass: "your-app-password",  // Use Gmail App Password
  },
};
```

### Port Configuration
Default port is 3001. To change it, set the `PORT` environment variable:
```bash
set PORT=3002
npm start
```

Or edit line 31 in `whatsapp-bulk.js`:
```javascript
const PORT = 3002; // Change to your preferred port
```

## Usage

1. Start the server:
   ```bash
   npm start
   ```

2. Open your browser and navigate to:
   ```
   http://localhost:3001/bulk-new.html
   ```

3. **First-time Setup**:
   - Select your country code (default: India +91)
   - Wait for the QR code to be generated
   - Check your email for the QR code
   - Scan the QR code with WhatsApp on your phone

4. **Sending Messages**:
   - Upload an Excel or CSV file with phone numbers
   - The file must have a column with phone numbers
   - Enter your message template (use `{name}`, `{phone}` for personalization)
   - Configure delay settings:
     - Base Delay: 20-60 seconds (default: 30)
     - Jitter: ±5-10 seconds (default: 5)
   - Set daily limit (default: 100)
   - Click "Start Sending"

## File Format

### Excel/CSV Requirements
- First row should contain headers
- One column must contain phone numbers (auto-detected or manually selected)
- Supported formats: `.xlsx`, `.xls`, `.csv`

### Example Excel Structure
```
| name    | phone       | message        |
|---------|-------------|----------------|
| John    | 9876543210  | Hello {name}!  |
| Jane    | 8765432109  | Hi {name}!    |
```

## API Endpoints

- `GET /api/status` - Check WhatsApp connection status
- `GET /api/health` - Health check endpoint
- `POST /api/send` - Send a single message
  - Body: `{ "number": "919876543210", "message": "Hello" }`
- `POST /api/send-bulk` - Send bulk messages from Excel file

## Rate Limiting

- **Session Limit**: Maximum 100 messages per session (hard limit)
- **Daily Limit**: Configurable (default 100 messages per day)
- **Random Delays**: Base delay (20-60s) ± jitter (5-10s) between each message
- Messages are sent sequentially (one at a time) to avoid rate limiting

## Authentication

WhatsApp credentials are saved in the `auth_info_bulk` directory. You don't need to re-scan the QR code unless:
- The `auth_info_bulk` directory is deleted
- You log out from WhatsApp on your phone
- The session expires

## Troubleshooting

### QR Code Not Generated
- Check the server console for errors
- Ensure email configuration is correct
- Check your spam folder for the QR code email

### Messages Not Sending
- Verify WhatsApp connection status in the UI
- Check if daily/session limits are reached
- Ensure phone numbers are in correct format
- Check the activity log for error details

### Connection Issues
- Delete the `auth_info_bulk` directory and restart the server
- Scan the QR code again
- Check your internet connection

## Project Structure

```
whatsapp-bulk-sender/
├── whatsapp-bulk.js          # Main server file
├── package.json              # Dependencies
├── README.md                 # This file
├── public/                   # Static files
│   ├── bulk-new.html        # Web interface
│   ├── css/
│   │   └── styles.css        # Styles
│   └── js/
│       └── app.js            # Frontend logic
├── auth_info_bulk/           # WhatsApp credentials (auto-generated)
└── uploads/                  # Temporary file uploads
```

## Dependencies

- express - Web server
- maher-zubair-baileys - WhatsApp Web API
- multer - File upload handling
- nodemailer - Email sending for QR codes
- qrcode - QR code generation
- socket.io - Real-time updates
- xlsx - Excel file parsing
- pino - Logging

## Security Notes

- **Email Credentials**: Use Gmail App Passwords, not your regular password
- **Rate Limiting**: Built-in limits to prevent WhatsApp account bans
- **Session Management**: Credentials stored locally, not in cloud

## License

ISC
