// Bulk email providers configuration
// Change `selected` to switch provider (or set BULK_EMAIL_PROVIDER env var)
export const bulkEmailConfig = {
  default: 'zoho',
  // selected can be changed at runtime by editing this file or via environment variable
  selected: process.env.BULK_EMAIL_PROVIDER || 'zoho',
  providers: {
    gmail: {
      service: 'gmail',
      auth: {
        user: process.env.BULK_GMAIL_USER || process.env.EMAIL_USER || '',
        pass: process.env.BULK_GMAIL_PASS || process.env.EMAIL_PASS || ''
      }
    },
    zoho: {
      host: 'smtp.zoho.com',
      port: 465,
      secure: true,
      auth: {
        user: process.env.ZOHO_USER || 'sales@appsthink.com',
        pass: process.env.ZOHO_PASS || 'yLze9KSTGz7k'
      }
    },
    outlook: {
      host: 'smtp.office365.com',
      port: 587,
      secure: false,
      auth: {
        user: process.env.OUTLOOK_USER || '',
        pass: process.env.OUTLOOK_PASS || ''
      }
    }
  }
};

export default bulkEmailConfig;
