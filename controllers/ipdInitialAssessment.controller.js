const IPDInitialAssessment = require('../models/IPDInitialAssessment');
const IPDAdmission = require('../models/IPDAdmission');

exports.getAssessmentByAdmissionId = async (req, res) => {
  try {
    const { admissionId } = req.params;
    let assessment = await IPDInitialAssessment.findOne({ admissionId }).populate('createdBy', 'firstName lastName').populate('updatedBy', 'firstName lastName');
    
    if (!assessment) {
      // Create empty assessment or just return 404/null
      return res.status(200).json({ success: true, assessment: null });
    }
    
    res.status(200).json({ success: true, assessment });
  } catch (error) {
    console.error('Error fetching initial assessment:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

exports.saveAssessment = async (req, res) => {
  try {
    const { admissionId } = req.params;
    const updateData = req.body;
    
    let assessment = await IPDInitialAssessment.findOne({ admissionId });
    
    if (assessment) {
      // Update
      updateData.updatedBy = req.user?._id;
      assessment = await IPDInitialAssessment.findOneAndUpdate(
        { admissionId },
        { $set: updateData },
        { new: true }
      );
    } else {
      // Create
      const admission = await IPDAdmission.findById(admissionId);
      if (!admission) {
        return res.status(404).json({ success: false, message: 'Admission not found' });
      }
      
      updateData.admissionId = admissionId;
      updateData.patientId = admission.patientId;
      updateData.createdBy = req.user?._id;
      
      assessment = new IPDInitialAssessment(updateData);
      await assessment.save();
    }
    
    res.status(200).json({ success: true, assessment, message: 'Assessment saved successfully' });
  } catch (error) {
    console.error('Error saving initial assessment:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};
