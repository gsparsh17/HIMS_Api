'use strict';

module.exports = {
  "patient_registration": {
    "domain": "AAC",
    "title": "Patient registration, identity and duplicate review",
    "description": "Configurable registration channels, required fields, OTP verification, duplicate matching, consent and offline synchronisation.",
    "fields": [
      {
        "key": "registrationChannel",
        "label": "Registration channel",
        "type": "select",
        "options": [
          "internal",
          "website",
          "kiosk",
          "mobile",
          "qr",
          "abdm_scan_share"
        ],
        "required": true
      },
      {
        "key": "identityVerified",
        "label": "Identity verified",
        "type": "boolean"
      },
      {
        "key": "mobileVerified",
        "label": "Mobile OTP verified",
        "type": "boolean"
      },
      {
        "key": "duplicateReview",
        "label": "Duplicate review result",
        "type": "select",
        "options": [
          "not_checked",
          "clear",
          "probable_duplicate",
          "confirmed_duplicate",
          "override_approved"
        ]
      },
      {
        "key": "offlineReference",
        "label": "Offline/local reference",
        "type": "text"
      },
      {
        "key": "paymentPreference",
        "label": "Payment preference",
        "type": "text"
      }
    ],
    "checklist": [
      "Confirm configured mandatory fields are captured",
      "Verify registration source/channel",
      "Verify mobile/identity status when required",
      "Run exact and probable duplicate search",
      "Confirm unique patient identifier",
      "Validate patient record can be retrieved and modified",
      "Confirm offline data synchronisation when applicable"
    ]
  },
  "patient_identity": {
    "domain": "AAC",
    "title": "Longitudinal patient identity and episode linkage",
    "description": "Links encounters, appointments, diagnostics, medications and billing under a unique patient identity and episodes of care.",
    "fields": [
      {
        "key": "patientIdentifier",
        "label": "Patient identifier",
        "type": "text",
        "required": true
      },
      {
        "key": "episodeReference",
        "label": "Episode reference",
        "type": "text"
      },
      {
        "key": "causeOfCare",
        "label": "Cause / condition",
        "type": "textarea"
      },
      {
        "key": "linkedModules",
        "label": "Linked modules",
        "type": "multiselect",
        "options": [
          "OPD",
          "IPD",
          "Laboratory",
          "Radiology",
          "Pharmacy",
          "Billing",
          "Insurance",
          "OT"
        ]
      }
    ],
    "checklist": [
      "Verify identifier uniqueness",
      "Verify records are linked across departments",
      "Verify episode groups repeat visits for the same cause",
      "Verify cross-module search retrieves the patient record"
    ]
  },
  "referral_interfacility": {
    "domain": "AAC",
    "title": "Referral and inter-facility continuity workflow",
    "description": "Consent-controlled referral with urgency, recipient acknowledgement and attached longitudinal clinical information.",
    "fields": [
      {
        "key": "recipientFacility",
        "label": "Recipient facility / specialist",
        "type": "text",
        "required": true
      },
      {
        "key": "specialty",
        "label": "Specialty",
        "type": "text"
      },
      {
        "key": "reason",
        "label": "Referral reason",
        "type": "textarea",
        "required": true
      },
      {
        "key": "urgency",
        "label": "Urgency",
        "type": "select",
        "options": [
          "routine",
          "urgent",
          "critical"
        ]
      },
      {
        "key": "consentReference",
        "label": "Consent reference",
        "type": "text"
      },
      {
        "key": "acknowledged",
        "label": "Recipient acknowledged",
        "type": "boolean"
      }
    ],
    "checklist": [
      "Confirm patient consent and permitted disclosure",
      "Select recipient and urgency",
      "Attach relevant clinical records",
      "Securely send referral",
      "Capture recipient acknowledgement",
      "Update patient longitudinal record"
    ]
  },
  "devices": {
    "domain": "AAC",
    "title": "External device integration evidence",
    "description": "Captures device type, identifier, timestamp, payload/checksum and operator for biometric, scanner, printer, barcode and medical-device integrations.",
    "fields": [
      {
        "key": "deviceType",
        "label": "Device type",
        "type": "select",
        "options": [
          "biometric",
          "document_scanner",
          "printer",
          "barcode_scanner",
          "medical_device",
          "other"
        ],
        "required": true
      },
      {
        "key": "deviceIdentifier",
        "label": "Device identifier",
        "type": "text",
        "required": true
      },
      {
        "key": "captureTimestamp",
        "label": "Capture timestamp",
        "type": "datetime",
        "required": true
      },
      {
        "key": "payloadReference",
        "label": "Payload / document reference",
        "type": "textarea"
      },
      {
        "key": "checksum",
        "label": "Checksum",
        "type": "text"
      }
    ],
    "checklist": [
      "Verify configured device is connected",
      "Capture or transmit test data",
      "Store device identifier and timestamp",
      "Verify data is retrievable and unaltered",
      "Record failure/retry behaviour"
    ]
  },
  "appointments_telehealth": {
    "domain": "AAC",
    "title": "Appointment, schedule and teleconsultation workflow",
    "description": "Physical/teleconsultation booking, modification, cancellation, conflict control, external synchronisation and patient notifications.",
    "fields": [
      {
        "key": "visitMode",
        "label": "Visit mode",
        "type": "select",
        "options": [
          "physical",
          "teleconsultation",
          "homecare"
        ],
        "required": true
      },
      {
        "key": "externalSystem",
        "label": "External booking system",
        "type": "text"
      },
      {
        "key": "externalAppointmentId",
        "label": "External appointment ID",
        "type": "text"
      },
      {
        "key": "communicationMode",
        "label": "Teleconsultation communication mode",
        "type": "select",
        "options": [
          "video",
          "phone",
          "chat",
          "not_applicable"
        ]
      },
      {
        "key": "consentCaptured",
        "label": "Teleconsultation consent captured",
        "type": "boolean"
      },
      {
        "key": "cancellationReason",
        "label": "Cancellation reason",
        "type": "textarea"
      }
    ],
    "checklist": [
      "Verify practitioner profile and availability",
      "Prevent slot conflict",
      "Create unique appointment reference",
      "Reflect booking in patient and practitioner schedules",
      "Send booking/change notification",
      "Verify modification and cancellation history",
      "Verify teleconsultation consent/link when applicable"
    ]
  },
  "queue": {
    "domain": "AAC",
    "title": "Patient queue and waiting-time management",
    "description": "Digital token assignment, prioritisation, display-board status, estimated wait and lifecycle timestamps.",
    "fields": [
      {
        "key": "servicePoint",
        "label": "Service point",
        "type": "text",
        "required": true
      },
      {
        "key": "token",
        "label": "Token",
        "type": "text",
        "required": true
      },
      {
        "key": "priority",
        "label": "Queue priority",
        "type": "select",
        "options": [
          "routine",
          "priority",
          "urgent",
          "emergency"
        ]
      },
      {
        "key": "estimatedWaitMinutes",
        "label": "Estimated wait (minutes)",
        "type": "number"
      },
      {
        "key": "displayStatus",
        "label": "Display-board status",
        "type": "select",
        "options": [
          "waiting",
          "called",
          "in_service",
          "completed",
          "cancelled"
        ]
      }
    ],
    "checklist": [
      "Assign a unique token",
      "Calculate queue position and estimated wait",
      "Apply priority without duplicate tokens",
      "Update display-board status",
      "Capture check-in, call, service-start and completion timestamps"
    ]
  },
  "diagnostics_lab": {
    "domain": "AAC",
    "title": "Laboratory order-to-report lifecycle",
    "description": "Order, specimen, rejection/repeat, result validation, critical notification, immutable release and controlled amendment.",
    "fields": [
      {
        "key": "requestNumber",
        "label": "Lab request number",
        "type": "text"
      },
      {
        "key": "specimenId",
        "label": "Specimen ID / barcode",
        "type": "text"
      },
      {
        "key": "collectionTime",
        "label": "Collection time",
        "type": "datetime"
      },
      {
        "key": "rejectionReason",
        "label": "Rejection / repeat reason",
        "type": "textarea"
      },
      {
        "key": "criticalResult",
        "label": "Critical result",
        "type": "boolean"
      },
      {
        "key": "patientNotified",
        "label": "Patient notified",
        "type": "boolean"
      },
      {
        "key": "doctorNotified",
        "label": "Doctor notified",
        "type": "boolean"
      }
    ],
    "checklist": [
      "Verify order is linked to patient/encounter",
      "Capture specimen collection and chain of custody",
      "Validate reference ranges and result entry",
      "Record rejection/repeat when applicable",
      "Release final report with checksum/version",
      "Notify patient/doctor and acknowledge critical result",
      "Use amendment workflow for post-release changes"
    ]
  },
  "diagnostics_radiology": {
    "domain": "AAC",
    "title": "Radiology order-to-report lifecycle",
    "description": "Scheduling, contraindication screening, DICOM metadata, interpretation, immutable release and controlled amendment.",
    "fields": [
      {
        "key": "requestNumber",
        "label": "Radiology request number",
        "type": "text"
      },
      {
        "key": "modality",
        "label": "Modality",
        "type": "text"
      },
      {
        "key": "contraindicationStatus",
        "label": "Contraindication screen",
        "type": "select",
        "options": [
          "not_assessed",
          "clear",
          "warning",
          "blocked",
          "overridden"
        ]
      },
      {
        "key": "dicomStudyUid",
        "label": "DICOM Study UID",
        "type": "text"
      },
      {
        "key": "criticalFinding",
        "label": "Critical finding",
        "type": "boolean"
      },
      {
        "key": "patientNotified",
        "label": "Patient notified",
        "type": "boolean"
      },
      {
        "key": "doctorNotified",
        "label": "Doctor notified",
        "type": "boolean"
      }
    ],
    "checklist": [
      "Verify order and patient identity",
      "Screen allergies, pregnancy, implants and renal risk",
      "Capture modality/DICOM metadata",
      "Validate and release final report",
      "Notify critical findings",
      "Use controlled amendment for post-release changes"
    ]
  },
  "admission_discharge": {
    "domain": "AAC",
    "title": "Admission, bed, transfer and discharge workflow",
    "description": "Admission criteria, bed allocation, transfer history, care documentation, discharge readiness, medication reconciliation and follow-up.",
    "fields": [
      {
        "key": "admissionNumber",
        "label": "Admission number",
        "type": "text"
      },
      {
        "key": "admissionType",
        "label": "Admission type",
        "type": "select",
        "options": [
          "elective",
          "emergency",
          "daycare",
          "observation"
        ]
      },
      {
        "key": "bedReference",
        "label": "Ward / room / bed",
        "type": "text"
      },
      {
        "key": "transferReason",
        "label": "Transfer reason",
        "type": "textarea"
      },
      {
        "key": "dischargeDisposition",
        "label": "Discharge disposition",
        "type": "select",
        "options": [
          "home",
          "transfer",
          "lama",
          "dama",
          "expired",
          "other"
        ]
      },
      {
        "key": "followUpDate",
        "label": "Follow-up date",
        "type": "date"
      }
    ],
    "checklist": [
      "Verify admission order and patient identity",
      "Allocate bed and capture admission timestamp",
      "Record transfers without overlapping accommodation",
      "Complete clinical/nursing documentation",
      "Complete discharge checklist and medication reconciliation",
      "Generate discharge summary and follow-up instructions",
      "Release bed and final bill"
    ]
  },
  "emergency_critical": {
    "domain": "COP",
    "title": "Emergency, triage and critical-care workflow",
    "description": "Triage, emergency timestamping, resuscitation/critical alerts, escalation, transfers and outcome documentation.",
    "fields": [
      {
        "key": "triageCategory",
        "label": "Triage category",
        "type": "select",
        "options": [
          "red",
          "orange",
          "yellow",
          "green",
          "blue"
        ],
        "required": true
      },
      {
        "key": "arrivalTime",
        "label": "Arrival time",
        "type": "datetime",
        "required": true
      },
      {
        "key": "firstAssessmentTime",
        "label": "First assessment time",
        "type": "datetime"
      },
      {
        "key": "escalationLevel",
        "label": "Escalation level",
        "type": "select",
        "options": [
          "none",
          "clinical_team",
          "consultant",
          "code_blue",
          "external_transfer"
        ]
      },
      {
        "key": "outcome",
        "label": "Outcome",
        "type": "textarea"
      }
    ],
    "checklist": [
      "Record arrival and triage timestamps",
      "Capture primary survey/vitals and risk category",
      "Trigger critical escalation when thresholds are met",
      "Document interventions and medicines",
      "Record transfer/admission/discharge outcome",
      "Verify audit trail and notification acknowledgement"
    ]
  },
  "clinical_assessment": {
    "domain": "COP",
    "title": "Structured clinical and nursing assessment",
    "description": "Configurable templates for history, examinations, vitals, allergies, pain, nursing assessment, consent and review.",
    "fields": [
      {
        "key": "assessmentType",
        "label": "Assessment type",
        "type": "text",
        "required": true
      },
      {
        "key": "chiefComplaint",
        "label": "Chief complaint",
        "type": "textarea"
      },
      {
        "key": "diagnosis",
        "label": "Diagnosis / impression",
        "type": "textarea"
      },
      {
        "key": "allergiesReviewed",
        "label": "Allergies reviewed",
        "type": "boolean"
      },
      {
        "key": "consentCaptured",
        "label": "Consent captured",
        "type": "boolean"
      },
      {
        "key": "reviewDueAt",
        "label": "Review due",
        "type": "datetime"
      }
    ],
    "checklist": [
      "Confirm patient and encounter",
      "Capture mandatory assessment fields",
      "Review allergies and prior history",
      "Record diagnosis and care instructions",
      "Capture consent when applicable",
      "Sign/finalise assessment and retain amendment history"
    ]
  },
  "nutrition": {
    "domain": "COP",
    "title": "Nutrition screening and diet plan",
    "description": "Nutrition risk screening, dietician referral, allergies/preferences and monitored diet plan.",
    "fields": [
      {
        "key": "screeningScore",
        "label": "Nutrition screening score",
        "type": "number"
      },
      {
        "key": "dietType",
        "label": "Diet type",
        "type": "text"
      },
      {
        "key": "allergies",
        "label": "Food allergies",
        "type": "textarea"
      },
      {
        "key": "dieticianReferral",
        "label": "Dietician referral required",
        "type": "boolean"
      },
      {
        "key": "reviewDate",
        "label": "Review date",
        "type": "date"
      }
    ],
    "checklist": [
      "Complete nutrition screening",
      "Review food allergies/preferences",
      "Create patient-specific diet plan",
      "Refer to dietician when threshold met",
      "Monitor intake and review plan"
    ]
  },
  "infection_incident": {
    "domain": "COP",
    "title": "Infection, incident and sentinel-event management",
    "description": "Incident reporting, notifiable disease escalation, root-cause analysis, corrective/preventive actions and closure.",
    "fields": [
      {
        "key": "incidentType",
        "label": "Incident type",
        "type": "text",
        "required": true
      },
      {
        "key": "severity",
        "label": "Severity",
        "type": "select",
        "options": [
          "near_miss",
          "minor",
          "moderate",
          "major",
          "sentinel"
        ],
        "required": true
      },
      {
        "key": "notifiable",
        "label": "Notifiable disease/event",
        "type": "boolean"
      },
      {
        "key": "immediateAction",
        "label": "Immediate action",
        "type": "textarea"
      },
      {
        "key": "rootCause",
        "label": "Root cause",
        "type": "textarea"
      },
      {
        "key": "capa",
        "label": "Corrective/preventive action",
        "type": "textarea"
      }
    ],
    "checklist": [
      "Record event promptly",
      "Protect patient and capture immediate action",
      "Notify infection control/leadership/regulator as applicable",
      "Complete investigation and root-cause analysis",
      "Assign and verify CAPA",
      "Close only after effectiveness review"
    ]
  },
  "homecare": {
    "domain": "COP",
    "title": "Home-care assessment and service workflow",
    "description": "Eligibility, consent, assigned team, visit plan, clinical records, equipment and escalation.",
    "fields": [
      {
        "key": "eligibility",
        "label": "Eligibility",
        "type": "select",
        "options": [
          "eligible",
          "not_eligible",
          "pending"
        ]
      },
      {
        "key": "consentCaptured",
        "label": "Home-care consent captured",
        "type": "boolean"
      },
      {
        "key": "assignedTeam",
        "label": "Assigned team",
        "type": "text"
      },
      {
        "key": "visitSchedule",
        "label": "Visit schedule",
        "type": "textarea"
      },
      {
        "key": "equipment",
        "label": "Equipment / consumables",
        "type": "textarea"
      },
      {
        "key": "escalationPlan",
        "label": "Escalation plan",
        "type": "textarea"
      }
    ],
    "checklist": [
      "Verify eligibility and consent",
      "Create care plan and visit schedule",
      "Assign qualified staff",
      "Record each visit and supplied items",
      "Escalate deterioration/adverse events",
      "Complete/discontinue service with summary"
    ]
  },
  "cdss_careplan": {
    "domain": "COP",
    "title": "Clinical decision support, risk and care-plan review",
    "description": "Configurable risk scores, rule-based alerts, care-plan actions, acknowledgements and overrides.",
    "fields": [
      {
        "key": "ruleType",
        "label": "Rule / score type",
        "type": "text"
      },
      {
        "key": "score",
        "label": "Calculated score",
        "type": "number"
      },
      {
        "key": "alertLevel",
        "label": "Alert level",
        "type": "select",
        "options": [
          "none",
          "info",
          "warning",
          "critical"
        ]
      },
      {
        "key": "recommendation",
        "label": "Recommendation",
        "type": "textarea"
      },
      {
        "key": "acknowledged",
        "label": "Alert acknowledged",
        "type": "boolean"
      },
      {
        "key": "overrideReason",
        "label": "Override reason",
        "type": "textarea"
      }
    ],
    "checklist": [
      "Capture required inputs",
      "Calculate score/rule result",
      "Display recommendation without replacing clinical judgement",
      "Require acknowledgement/override reason for significant alerts",
      "Create or update care plan",
      "Record review and outcome"
    ]
  },
  "medication_safety": {
    "domain": "MOM",
    "title": "Medication safety and administration workflow",
    "description": "Formulary, allergy/interaction/LASA/high-risk checks, reconciliation, barcode/double-check, administration and error reporting.",
    "fields": [
      {
        "key": "medicineReference",
        "label": "Medicine / order reference",
        "type": "text"
      },
      {
        "key": "formularyStatus",
        "label": "Formulary status",
        "type": "select",
        "options": [
          "formulary",
          "non_formulary",
          "emergency",
          "unknown"
        ]
      },
      {
        "key": "highRisk",
        "label": "High-risk medicine",
        "type": "boolean"
      },
      {
        "key": "lasa",
        "label": "LASA medicine",
        "type": "boolean"
      },
      {
        "key": "interactionAlert",
        "label": "Interaction/allergy alert",
        "type": "textarea"
      },
      {
        "key": "doubleCheckCompleted",
        "label": "Independent double-check",
        "type": "boolean"
      },
      {
        "key": "barcodeVerified",
        "label": "Patient/medicine barcode verified",
        "type": "boolean"
      },
      {
        "key": "administrationOutcome",
        "label": "Administration outcome",
        "type": "textarea"
      }
    ],
    "checklist": [
      "Complete medication reconciliation",
      "Check allergy, duplication, interaction and dose",
      "Apply formulary/alternative guidance",
      "Require independent check for high-risk medicines",
      "Verify right patient/drug/dose/route/time",
      "Record administration/non-administration",
      "Report and review medication error/adverse reaction"
    ]
  },
  "security_access": {
    "domain": "DAC",
    "title": "Digital access and security control",
    "description": "Password policy, MFA/SSO, lockout, role access, idle session controls, audit evidence and security incident handling.",
    "fields": [
      {
        "key": "controlType",
        "label": "Security control",
        "type": "text",
        "required": true
      },
      {
        "key": "userRole",
        "label": "User role",
        "type": "text"
      },
      {
        "key": "testResult",
        "label": "Test result",
        "type": "select",
        "options": [
          "pass",
          "fail",
          "blocked",
          "not_applicable"
        ]
      },
      {
        "key": "evidenceReference",
        "label": "Evidence reference",
        "type": "textarea"
      },
      {
        "key": "exceptionReason",
        "label": "Exception / override reason",
        "type": "textarea"
      }
    ],
    "checklist": [
      "Verify least-privilege role access",
      "Test password/MFA/SSO control as applicable",
      "Test failed-login lockout and idle timeout",
      "Verify sensitive action audit trail",
      "Verify final records are immutable and amendments controlled",
      "Record security exception and corrective action"
    ]
  },
  "operations": {
    "domain": "DOM",
    "title": "Digital operations and continuity control",
    "description": "Backup, restore drill, archive/retention, downtime, releases, support, migration, interface monitoring and business continuity.",
    "fields": [
      {
        "key": "operationType",
        "label": "Operation type",
        "type": "select",
        "options": [
          "backup",
          "restore_drill",
          "archive",
          "downtime",
          "release",
          "support",
          "migration",
          "interface_monitoring",
          "business_continuity"
        ],
        "required": true
      },
      {
        "key": "scheduledAt",
        "label": "Scheduled at",
        "type": "datetime"
      },
      {
        "key": "completedAt",
        "label": "Completed at",
        "type": "datetime"
      },
      {
        "key": "result",
        "label": "Result",
        "type": "select",
        "options": [
          "planned",
          "successful",
          "failed",
          "partial"
        ]
      },
      {
        "key": "evidenceReference",
        "label": "Evidence / log reference",
        "type": "textarea"
      },
      {
        "key": "rollbackPlan",
        "label": "Rollback / recovery plan",
        "type": "textarea"
      }
    ],
    "checklist": [
      "Define owner, schedule and acceptance criteria",
      "Execute operation or drill",
      "Capture evidence, duration and result",
      "Validate recovery/data integrity where applicable",
      "Record issue, rollback and corrective action",
      "Obtain review/approval and close"
    ]
  },
  "vendor_finance": {
    "domain": "FPM",
    "title": "Vendor, procurement and payment workflow",
    "description": "Vendor due diligence, requisition/approval, quotation, purchase, receipt, invoice matching, payment scheduling and quality review.",
    "fields": [
      {
        "key": "vendorReference",
        "label": "Vendor / supplier",
        "type": "text"
      },
      {
        "key": "requestReference",
        "label": "Requisition / PO reference",
        "type": "text"
      },
      {
        "key": "invoiceReference",
        "label": "Invoice reference",
        "type": "text"
      },
      {
        "key": "amount",
        "label": "Amount",
        "type": "number"
      },
      {
        "key": "dueDate",
        "label": "Payment due date",
        "type": "date"
      },
      {
        "key": "threeWayMatch",
        "label": "PO/GRN/invoice matched",
        "type": "boolean"
      },
      {
        "key": "qualityStatus",
        "label": "Quality status",
        "type": "select",
        "options": [
          "pending",
          "accepted",
          "rejected",
          "conditional"
        ]
      }
    ],
    "checklist": [
      "Verify approved vendor and documents",
      "Capture requisition and approval",
      "Record quotation/comparison and PO",
      "Confirm goods/service receipt and quality",
      "Perform invoice/PO/receipt match",
      "Schedule/record payment and statutory deductions",
      "Review vendor performance"
    ]
  },
  "billing_insurance": {
    "domain": "FPM",
    "title": "Billing, receipt, refund and insurance workflow",
    "description": "Charge capture, tariffs, estimates, discounts/approvals, invoices, receipts, refunds, sponsor/claim lifecycle and reconciliation.",
    "fields": [
      {
        "key": "billingReference",
        "label": "Invoice / claim reference",
        "type": "text"
      },
      {
        "key": "payerType",
        "label": "Payer type",
        "type": "select",
        "options": [
          "self",
          "insurance",
          "corporate",
          "government",
          "charity"
        ]
      },
      {
        "key": "tariffReference",
        "label": "Tariff / rate card reference",
        "type": "text"
      },
      {
        "key": "grossAmount",
        "label": "Gross amount",
        "type": "number"
      },
      {
        "key": "discount",
        "label": "Discount",
        "type": "number"
      },
      {
        "key": "netAmount",
        "label": "Net amount",
        "type": "number"
      },
      {
        "key": "approvalReference",
        "label": "Approval / pre-authorisation",
        "type": "text"
      },
      {
        "key": "settlementStatus",
        "label": "Settlement status",
        "type": "select",
        "options": [
          "open",
          "partial",
          "settled",
          "rejected",
          "refunded",
          "written_off"
        ]
      }
    ],
    "checklist": [
      "Link all charges to patient/encounter",
      "Apply active tariff and coverage rules",
      "Obtain approval for discount/override",
      "Generate itemised invoice/estimate",
      "Record receipt/refund with payment reference",
      "Submit and track claim/pre-authorisation when applicable",
      "Reconcile patient and sponsor ledgers"
    ]
  },
  "workforce": {
    "domain": "HRM",
    "title": "Workforce lifecycle and competency workflow",
    "description": "Recruitment, credential verification, induction, training, roster/attendance, appraisal, health/safety and exit clearance.",
    "fields": [
      {
        "key": "employeeReference",
        "label": "Employee / candidate",
        "type": "text"
      },
      {
        "key": "processType",
        "label": "HR process",
        "type": "select",
        "options": [
          "recruitment",
          "credentialing",
          "induction",
          "training",
          "competency",
          "roster",
          "attendance",
          "appraisal",
          "health_safety",
          "exit"
        ],
        "required": true
      },
      {
        "key": "department",
        "label": "Department",
        "type": "text"
      },
      {
        "key": "dueDate",
        "label": "Due date",
        "type": "date"
      },
      {
        "key": "result",
        "label": "Result",
        "type": "select",
        "options": [
          "pending",
          "competent",
          "needs_improvement",
          "completed",
          "failed"
        ]
      },
      {
        "key": "evidenceReference",
        "label": "Evidence / certificate reference",
        "type": "textarea"
      }
    ],
    "checklist": [
      "Verify identity, qualification, license and background as applicable",
      "Complete approval/induction requirements",
      "Assign role, department and access",
      "Record training/competency and expiry",
      "Monitor attendance, roster, leave and appraisal",
      "Complete exit clearance and revoke access"
    ]
  },
  "terminology": {
    "domain": "IMS",
    "title": "Terminology and interoperability management",
    "description": "ICD, SNOMED CT, LOINC, NRCeS and local codes with version, synonyms, active state and mapping evidence.",
    "fields": [
      {
        "key": "system",
        "label": "Terminology system",
        "type": "select",
        "options": [
          "ICD-10",
          "ICD-11",
          "SNOMED_CT",
          "LOINC",
          "NRCeS",
          "LOCAL"
        ],
        "required": true
      },
      {
        "key": "version",
        "label": "Version",
        "type": "text"
      },
      {
        "key": "code",
        "label": "Code",
        "type": "text",
        "required": true
      },
      {
        "key": "display",
        "label": "Display",
        "type": "text",
        "required": true
      },
      {
        "key": "mappingReference",
        "label": "Mapping / source reference",
        "type": "textarea"
      }
    ],
    "checklist": [
      "Verify code system and version",
      "Validate code/display and active state",
      "Record synonyms/mapping",
      "Use code in relevant clinical workflow",
      "Verify export/interoperability representation",
      "Review updates and retire obsolete codes"
    ]
  },
  "kpi": {
    "domain": "IMS",
    "title": "Quarterly KPI definition and publication",
    "description": "Metric definition, numerator/denominator, data source, validation, approval, period and export/publication.",
    "fields": [
      {
        "key": "quarter",
        "label": "Quarter",
        "type": "text",
        "required": true
      },
      {
        "key": "metric",
        "label": "Metric name",
        "type": "text",
        "required": true
      },
      {
        "key": "numerator",
        "label": "Numerator",
        "type": "number"
      },
      {
        "key": "denominator",
        "label": "Denominator",
        "type": "number"
      },
      {
        "key": "value",
        "label": "Value",
        "type": "number"
      },
      {
        "key": "dataSource",
        "label": "Data source",
        "type": "textarea"
      },
      {
        "key": "approvedForPublication",
        "label": "Approved for publication",
        "type": "boolean"
      }
    ],
    "checklist": [
      "Define metric and period",
      "Validate numerator/denominator/data source",
      "Reconcile with source modules",
      "Obtain reviewer approval",
      "Publish/export with version and timestamp"
    ]
  },
  "clinical_operations": {
    "domain": "COP",
    "title": "Clinical operational compliance workflow",
    "description": "Flexible audited workflow for clinical requirements not represented by a more specialised module.",
    "fields": [
      {
        "key": "processType",
        "label": "Process type",
        "type": "text",
        "required": true
      },
      {
        "key": "clinicalSummary",
        "label": "Clinical summary",
        "type": "textarea"
      },
      {
        "key": "responsibleTeam",
        "label": "Responsible team",
        "type": "text"
      },
      {
        "key": "dueAt",
        "label": "Due at",
        "type": "datetime"
      },
      {
        "key": "outcome",
        "label": "Outcome",
        "type": "textarea"
      }
    ],
    "checklist": [
      "Confirm patient/process context",
      "Complete mandatory data capture",
      "Verify review/approval requirements",
      "Record communication/escalation",
      "Finalise evidence and retain controlled amendment history"
    ]
  }
};
