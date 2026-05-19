const nodemailer = require('nodemailer');

class EmailService {
  constructor() {
    this.transporter = nodemailer.createTransport({
      service: 'Gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      },
      pool: true,
      maxConnections: 5,
      maxMessages: 100
    });
  }

  async sendCTADemoRequest({ name, hospitalName, city, pincode, whatsapp }) {
    try {
      // Email to your team (hello@mediqliq.com)
      const adminMailOptions = {
        from: `"MediQliq Website" <${process.env.EMAIL_USER}>`,
        to: process.env.RECIPIENT_EMAIL,
        subject: `🎯 New Demo Request${name ? ` from ${name}` : ''}`,
        html: `
          <!DOCTYPE html>
          <html>
          <head>
            <style>
              body { font-family: 'Segoe UI', Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; }
              .container { max-width: 600px; margin: 0 auto; padding: 20px; }
              .header { background: linear-gradient(135deg, #0a2b3e 0%, #1a4a6f 100%); color: white; padding: 30px; text-align: center; border-radius: 15px 15px 0 0; }
              .logo { font-size: 28px; font-weight: bold; margin-bottom: 10px; }
              .badge { background: #4db8a0; padding: 5px 12px; border-radius: 20px; font-size: 12px; display: inline-block; }
              .content { background: #ffffff; padding: 30px; border-radius: 0 0 15px 15px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
              .field { margin-bottom: 25px; padding-bottom: 15px; border-bottom: 1px solid #e0e0e0; }
              .label { font-weight: bold; color: #1a4a6f; margin-bottom: 8px; font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px; }
              .value { font-size: 16px; color: #2c3e50; margin-top: 5px; }
              .value strong { color: #0a2b3e; }
              .whatsapp-badge { background: #25D366; color: white; padding: 8px 15px; border-radius: 25px; display: inline-block; font-weight: bold; }
              .footer { text-align: center; margin-top: 30px; padding-top: 20px; font-size: 12px; color: #7f8c8d; border-top: 1px solid #e0e0e0; }
              .urgency { background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin-top: 20px; border-radius: 8px; }
              .details-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-top: 10px; }
              @media (max-width: 480px) {
                .details-grid { grid-template-columns: 1fr; }
              }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="header">
                <div class="logo">🏥 MediQliq</div>
                <div class="badge">NEW DEMO REQUEST</div>
                <p style="margin-top: 15px; opacity: 0.9;">Received from website contact form</p>
              </div>
              <div class="content">
                <div class="details-grid">
                  <div class="field">
                    <div class="label">👤 Hospital Name</div>
                    <div class="value"><strong>${this.escapeHtml(hospitalName || 'Not provided')}</strong></div>
                  </div>
                  
                  <div class="field">
                    <div class="label">📋 Requester Name</div>
                    <div class="value"><strong>${this.escapeHtml(name || 'Not provided')}</strong></div>
                  </div>
                  
                  <div class="field">
                    <div class="label">📞 WhatsApp Number</div>
                    <div class="value">
                      <span class="whatsapp-badge">📱 ${this.escapeHtml(whatsapp || 'Not provided')}</span>
                    </div>
                  </div>
                  
                  <div class="field">
                    <div class="label">🏙️ City</div>
                    <div class="value"><strong>${this.escapeHtml(city || 'Not provided')}</strong></div>
                  </div>
                  
                  <div class="field">
                    <div class="label">📮 Pincode</div>
                    <div class="value"><strong>${this.escapeHtml(pincode || 'Not provided')}</strong></div>
                  </div>
                </div>

                <div class="field">
                  <div class="label">🕐 Request Time</div>
                  <div class="value">${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</div>
                </div>
                
                <div class="urgency">
                  <strong>⚠️ Action Required:</strong> Please contact this lead within 24 hours via WhatsApp at <strong>${this.escapeHtml(whatsapp || 'provided number')}</strong>
                </div>

                <div style="margin-top: 20px; background: #e8f4f1; padding: 15px; border-radius: 8px;">
                  <p style="margin: 0; color: #2c5f5f; font-size: 13px;">
                    💡 <strong>Quick Actions:</strong><br>
                    • Save this WhatsApp number to your contacts<br>
                    • Send a greeting message within 2 hours for best conversion<br>
                    • Schedule the 30-minute demo walkthrough<br>
                    • Prepare a pitch customized for ${this.escapeHtml(city || 'this location')}
                  </p>
                </div>
              </div>
              <div class="footer">
                <p>Sent from MediQliq Website Contact Form</p>
                <p style="margin-top: 5px;">© 2024 MediQliq - Transforming Hospital Management</p>
              </div>
            </div>
          </body>
          </html>
        `,
        text: `
═══════════════════════════════════════
         NEW DEMO REQUEST
═══════════════════════════════════════

Hospital Name: ${hospitalName || 'Not provided'}
Requester Name: ${name || 'Not provided'}
WhatsApp Number: ${whatsapp || 'Not provided'}
City: ${city || 'Not provided'}
Pincode: ${pincode || 'Not provided'}

Request Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}

⚠️ ACTION REQUIRED: Contact this lead within 24 hours via WhatsApp

Quick Actions:
• Save WhatsApp number to contacts
• Send greeting message within 2 hours
• Schedule 30-minute demo
• Prepare customized pitch for ${city || 'this location'}

═══════════════════════════════════════
        `
      };

      // Auto-reply to the user (if WhatsApp number is provided, send SMS/WhatsApp would be better)
      // For now, we'll send an email if available, but since we only have WhatsApp,
      // we'll skip auto-reply as WhatsApp API requires additional setup.
      // You can integrate WhatsApp Business API later.

      await this.transporter.sendMail(adminMailOptions);
      
      return { success: true, message: "Demo request sent successfully!" };
    } catch (error) {
      console.error("Email sending error:", error);
      throw new Error(`Failed to send email: ${error.message}`);
    }
  }

  escapeHtml(text) {
    if (!text) return '';
    const htmlEntities = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    };
    return text.replace(/[&<>"']/g, (char) => htmlEntities[char]);
  }
}

module.exports = new EmailService();