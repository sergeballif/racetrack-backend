const nodemailer = require('nodemailer');

// Email transporter setup
let transporter = null;

function initEmailService() {
  // Check if email configuration is available
  if (!process.env.EMAIL_SERVICE || !process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.log('[EMAIL] Email configuration not found, email notifications disabled');
    return null;
  }

  try {
    // Create transporter for Gmail or other services
    transporter = nodemailer.createTransport({
      service: process.env.EMAIL_SERVICE, // 'gmail', 'yahoo', 'outlook', etc.
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      }
    });

    console.log('[EMAIL] Email service initialized successfully');
    console.log(`[EMAIL] Using service: ${process.env.EMAIL_SERVICE}, user: ${process.env.EMAIL_USER}`);
    return transporter;
  } catch (error) {
    console.error('[EMAIL] Failed to initialize email service:', error);
    return null;
  }
}

// Send replay notification email
async function sendReplayNotification(recipientEmail, sessionSlug, quizFilename) {
  if (!transporter) {
    console.log('[EMAIL] Email service not available, skipping notification');
    return false;
  }

  try {
    // Construct the replay URL
    const baseUrl = process.env.FRONTEND_URL || 'https://science.github.io/quiz-game'; // Update with your GitHub Pages URL
    const replayUrl = `${baseUrl}?session=${sessionSlug}&mode=replay`;
    
    // Construct the deletion URL 
    const backendUrl = process.env.BACKEND_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000';
    const deleteUrl = `${backendUrl}/api/session/${sessionSlug}`;

    // Clean up filename for display
    const displayName = quizFilename.replace(/\.[^/.]+$/, '').replace(/[-_]/g, ' ');
    const currentDate = new Date().toLocaleDateString('en-US', { 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric' 
    });

    const emailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2563eb;">Quiz Replay Link Ready! 🎮</h2>
        
        <p>Your quiz session has been recorded and is ready for replay:</p>
        
        <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <h3 style="margin: 0 0 10px 0; color: #374151;">📚 ${displayName}</h3>
          <p style="margin: 0; color: #6b7280;">Recorded on ${currentDate}</p>
        </div>

        <div style="background: #fff; border: 2px solid #e5e7eb; border-radius: 8px; padding: 20px; margin: 20px 0;">
          <h4 style="margin: 0 0 10px 0;">🔗 Replay URL:</h4>
          <a href="${replayUrl}" style="color: #2563eb; text-decoration: none; word-break: break-all;">
            ${replayUrl}
          </a>
        </div>

        <div style="background: #fef3c7; border-left: 4px solid #f59e0b; padding: 15px; margin: 20px 0;">
          <h4 style="margin: 0 0 10px 0; color: #92400e;">📧 For Students Who Missed Class:</h4>
          <p style="margin: 0; color: #92400e;">Share this URL with students who were absent. They can play through the quiz at their own pace and compete against the live session results!</p>
        </div>

        <div style="background: #fee2e2; border-left: 4px solid #ef4444; padding: 15px; margin: 20px 0;">
          <h4 style="margin: 0 0 10px 0; color: #dc2626;">🗑️ Delete This Session (Optional):</h4>
          <p style="margin: 0 0 10px 0; color: #dc2626;">If this was a practice round or you won't need this replay, you can delete it to save database space:</p>
          <p style="margin: 0;">
            <a href="${backendUrl}/delete/${sessionSlug}" style="color: #dc2626; text-decoration: underline;">
              Click here to delete session
            </a>
          </p>
        </div>

        <div style="background: #f0f9ff; border-left: 4px solid #3b82f6; padding: 15px; margin: 20px 0;">
          <h4 style="margin: 0 0 10px 0; color: #1e40af;">ℹ️ How Replay Mode Works:</h4>
          <ul style="margin: 10px 0; color: #1e40af; padding-left: 20px;">
            <li>Students can advance questions at their own pace</li>
            <li>Their token appears alongside recorded live players</li>
            <li>Full competitive experience preserved</li>
            <li>No time pressure - perfect for makeup sessions</li>
          </ul>
        </div>

        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 30px 0;">
        <p style="color: #6b7280; font-size: 14px; text-align: center;">
          Generated by Quiz Game Replay System<br>
          <a href="${replayUrl}" style="color: #2563eb;">Click here to test the replay link</a>
        </p>
      </div>
    `;

    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: recipientEmail,
      subject: `📚 Quiz Replay Ready: ${displayName} (${currentDate})`,
      html: emailHtml,
      text: `
Quiz Replay Link Ready!

Quiz: ${displayName}
Date: ${currentDate}

Replay URL: ${replayUrl}

Share this URL with students who missed the live session. They can play through the quiz at their own pace and compete against the recorded results!

How it works:
- Students advance questions themselves
- Their token appears with live players
- Full competitive experience
- Perfect for makeup sessions
      `
    };

    await transporter.sendMail(mailOptions);
    console.log(`[EMAIL] Replay notification sent to ${recipientEmail} for session ${sessionSlug}`);
    return true;
  } catch (error) {
    console.error('[EMAIL] Failed to send replay notification:', error);
    return false;
  }
}

// Test email configuration
async function testEmailService() {
  // First check if we have environment variables
  if (!process.env.EMAIL_SERVICE || !process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    return { 
      success: false, 
      message: 'Email configuration missing: EMAIL_SERVICE, EMAIL_USER, or EMAIL_PASS not set' 
    };
  }

  // Re-initialize transporter if it doesn't exist
  if (!transporter) {
    console.log('[EMAIL] Transporter not found, attempting to re-initialize...');
    initEmailService();
  }

  if (!transporter) {
    return { success: false, message: 'Email service initialization failed' };
  }

  try {
    console.log('[EMAIL] Testing connection...');
    await transporter.verify();
    console.log('[EMAIL] Connection test successful');
    return { success: true, message: 'Email service is working correctly' };
  } catch (error) {
    console.error('[EMAIL] Connection test failed:', error);
    return { success: false, message: `Connection failed: ${error.message}` };
  }
}

module.exports = {
  initEmailService,
  sendReplayNotification,
  testEmailService
};