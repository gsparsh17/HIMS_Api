const emailService = require('../services/emailService');

class EmailController {
  async sendDemoRequest(req, res) {
    try {
      const { name, hospitalName, city, pincode, whatsapp } = req.body;

      // Validate all required fields are present
      if (!hospitalName || !name || !whatsapp || !city || !pincode) {
        return res.status(400).json({
          success: false,
          message: "All fields are required: hospital name, name, WhatsApp number, city, and pincode"
        });
      }

      const result = await emailService.sendCTADemoRequest({
        name,
        hospitalName,
        city,
        pincode,
        whatsapp
      });

      res.status(200).json({
        success: true,
        message: "Demo request sent successfully! Our team will contact you shortly on WhatsApp.",
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Controller error:', error);
      res.status(500).json({
        success: false,
        message: "Unable to send demo request. Please try again later or call us directly.",
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  }

  async healthCheck(req, res) {
    res.status(200).json({
      status: 'OK',
      service: 'MediQliq Email API',
      timestamp: new Date().toISOString()
    });
  }
}

module.exports = new EmailController();