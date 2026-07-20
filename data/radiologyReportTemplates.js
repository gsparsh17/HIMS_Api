const slugify = (value) => String(value)
  .toLowerCase()
  .replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '');

const section = (key, label, options = {}) => ({
  key,
  label,
  type: options.type || 'textarea',
  defaultText: options.defaultText || '',
  required: Boolean(options.required),
  rows: options.rows || 4,
  helpText: options.helpText || ''
});

const table = (key, label, columns, rows = []) => ({ key, label, columns, rows });

const standardClosing = [
  section('impression', 'Impression', { required: true, rows: 4 }),
  section('advice', 'Advice / Recommendation', { rows: 3 })
];

const genericCrossSectional = [
  section('clinicalInformation', 'Clinical Information / Indication', { rows: 3 }),
  section('part', 'Part / Region Examined', { rows: 2 }),
  section('technique', 'Technique', { required: true, rows: 4 }),
  section('comparison', 'Comparison', { rows: 2 }),
  section('findings', 'Findings', { required: true, rows: 10 }),
  ...standardClosing
];

const genericXray = [
  section('view', 'View / Projection', { rows: 2 }),
  section('clinicalInformation', 'Clinical Information', { rows: 2 }),
  section('findings', 'Findings', { required: true, rows: 8 }),
  ...standardClosing
];

const mriSections = (name) => {
  const lower = name.toLowerCase();
  const opening = [
    section('clinicalInformation', 'Clinical Information / Indication', { rows: 3 }),
    section('technique', 'Technique and Sequences', { required: true, rows: 4 }),
    section('comparison', 'Comparison', { rows: 2 })
  ];
  if (lower.includes('brain')) return [...opening,
    section('brainParenchyma', 'Brain Parenchyma', { rows: 6 }),
    section('ventriclesCisterns', 'Ventricles, Cisterns and Extra-Axial Spaces', { rows: 4 }),
    section('posteriorFossa', 'Posterior Fossa and Brainstem', { rows: 4 }),
    section('vascularFlowVoids', 'Major Vascular Flow Voids', { rows: 3 }),
    section('orbitsSinuses', 'Orbits, Paranasal Sinuses and Calvarium', { rows: 4 }), ...standardClosing];
  if (lower.includes('cn vii')) return [...opening,
    section('iapCpa', 'Internal Auditory Canals and Cerebellopontine Angles', { rows: 5 }),
    section('cranialNerves', 'Facial and Vestibulocochlear Nerves', { rows: 5 }),
    section('innerEar', 'Labyrinth and Inner Ear Structures', { rows: 4 }),
    section('brainstem', 'Brainstem and Posterior Fossa', { rows: 4 }), ...standardClosing];
  if (lower.includes('spine')) return [...opening,
    section('alignment', 'Alignment and Curvature', { rows: 3 }),
    section('vertebrae', 'Vertebral Bodies and Marrow Signal', { rows: 5 }),
    section('discs', 'Intervertebral Discs and End Plates', { rows: 6 }),
    section('canalCord', 'Spinal Canal, Cord / Conus and Nerve Roots', { rows: 6 }),
    section('levels', 'Level-wise Findings', { rows: 9 }),
    section('paraspinal', 'Paraspinal Soft Tissues', { rows: 3 }), ...standardClosing];
  if (lower.includes('brachial plexus')) return [...opening,
    section('rootsTrunks', 'Roots, Trunks and Divisions', { rows: 6 }),
    section('cordsBranches', 'Cords and Terminal Branches', { rows: 5 }),
    section('muscles', 'Regional Muscles and Denervation Changes', { rows: 4 }),
    section('adjacentStructures', 'Adjacent Vessels, Lung Apex and Bones', { rows: 4 }), ...standardClosing];
  if (lower.includes('enterography')) return [...opening,
    section('stomachSmallBowel', 'Stomach and Small Bowel', { rows: 7 }),
    section('activeInflammation', 'Active Inflammation / Stricture / Fistula', { rows: 6 }),
    section('colon', 'Colon and Rectum', { rows: 4 }),
    section('mesenteryNodes', 'Mesentery, Nodes and Collections', { rows: 4 }),
    section('solidOrgans', 'Solid Abdominal and Pelvic Organs', { rows: 5 }), ...standardClosing];
  if (lower.includes('liver')) return [...opening,
    section('liver', 'Liver Morphology and Signal', { rows: 6 }),
    section('lesions', 'Focal Lesions and Enhancement Pattern', { rows: 7 }),
    section('biliary', 'Gall Bladder and Biliary Tree', { rows: 4 }),
    section('vessels', 'Portal and Hepatic Vessels', { rows: 4 }),
    section('otherAbdomen', 'Other Upper Abdominal Findings', { rows: 4 }), ...standardClosing];
  if (lower.includes('abdomen') || lower.includes('pelvis')) return [...opening,
    section('hepatobiliary', 'Liver, Gall Bladder and Biliary Tree', { rows: 5 }),
    section('pancreasSpleen', 'Pancreas and Spleen', { rows: 4 }),
    section('urinary', 'Kidneys, Adrenals and Urinary Tract', { rows: 5 }),
    section('bowelPeritoneum', 'Bowel, Mesentery and Peritoneum', { rows: 5 }),
    section('pelvicOrgans', 'Pelvic Organs', { rows: 5 }),
    section('nodesVesselsBones', 'Nodes, Vessels and Bones', { rows: 4 }), ...standardClosing];
  if (lower.includes('foetal')) return [...opening,
    section('fetalBrain', 'Fetal Brain and Posterior Fossa', { rows: 6 }),
    section('faceNeck', 'Face and Neck', { rows: 4 }),
    section('thorax', 'Thorax and Heart', { rows: 5 }),
    section('abdomenPelvis', 'Abdomen and Pelvis', { rows: 5 }),
    section('spineLimbs', 'Spine and Limbs', { rows: 5 }),
    section('placentaLiquor', 'Placenta, Cord and Liquor', { rows: 4 }), ...standardClosing];
  return [...opening,
    section('bonesAlignment', 'Bones, Alignment and Marrow Signal', { rows: 5 }),
    section('cartilageJoint', 'Articular Cartilage and Joint', { rows: 5 }),
    section('ligamentsTendons', 'Ligaments, Tendons and Muscles', { rows: 7 }),
    section('softTissues', 'Soft Tissues and Neurovascular Structures', { rows: 4 }), ...standardClosing];
};

const ctSections = (name) => {
  const lower = name.toLowerCase();
  const opening = [
    section('clinicalInformation', 'Clinical Information / Indication', { rows: 3 }),
    section('technique', 'Technique and Contrast', { required: true, rows: 4 }),
    section('comparison', 'Comparison', { rows: 2 })
  ];
  if (lower.includes('brain') || lower.includes('head')) return [...opening,
    section('brainParenchyma', 'Brain Parenchyma', { rows: 6 }),
    section('ventriclesCisterns', 'Ventricles, Cisterns and Extra-Axial Spaces', { rows: 4 }),
    section('posteriorFossa', 'Posterior Fossa', { rows: 3 }),
    section('skullSinuses', 'Calvarium, Skull Base, Orbits and Sinuses', { rows: 5 }), ...standardClosing];
  if (lower.includes('pns')) return [...opening,
    section('sinuses', 'Paranasal Sinuses', { rows: 7 }),
    section('ostiomeatal', 'Ostiomeatal Units and Nasal Cavity', { rows: 5 }),
    section('variants', 'Anatomical Variants', { rows: 4 }),
    section('orbitsBones', 'Orbits and Facial Bones', { rows: 4 }), ...standardClosing];
  if (lower.includes('temporal')) return [...opening,
    section('externalMiddleEar', 'External and Middle Ear', { rows: 6 }),
    section('ossiclesMastoid', 'Ossicles, Epitympanum and Mastoid', { rows: 5 }),
    section('innerEar', 'Inner Ear and Internal Auditory Canal', { rows: 5 }),
    section('facialCanal', 'Facial Nerve Canal and Tegmen', { rows: 4 }), ...standardClosing];
  if (lower.includes('skull base') || lower.includes('facial bones')) return [...opening,
    section('bones', 'Bones and Fracture Assessment', { rows: 7 }),
    section('orbitsSinuses', 'Orbits and Paranasal Sinuses', { rows: 5 }),
    section('softTissues', 'Facial / Skull Base Soft Tissues', { rows: 5 }),
    section('canalsForamina', 'Canals and Neural Foramina', { rows: 4 }), ...standardClosing];
  if (lower.includes('neck')) return [...opening,
    section('pharynxLarynx', 'Nasopharynx, Oropharynx, Hypopharynx and Larynx', { rows: 6 }),
    section('salivaryThyroid', 'Salivary Glands and Thyroid', { rows: 4 }),
    section('nodesSpaces', 'Deep Neck Spaces and Lymph Nodes', { rows: 6 }),
    section('vesselsBones', 'Vessels, Spine and Lung Apices', { rows: 4 }), ...standardClosing];
  if (lower.includes('chest') || lower.includes('bronchoscopy')) return [...opening,
    section('airways', 'Trachea and Bronchial Tree', { rows: 5 }),
    section('lungs', 'Lungs', { rows: 8 }),
    section('pleura', 'Pleura and Chest Wall', { rows: 4 }),
    section('mediastinum', 'Mediastinum, Hila and Lymph Nodes', { rows: 5 }),
    section('heartVessels', 'Heart and Great Vessels', { rows: 4 }),
    section('upperAbdomenBones', 'Upper Abdomen and Bones', { rows: 4 }), ...standardClosing];
  if (lower.includes('pulmonary angiogram')) return [...opening,
    section('pulmonaryArteries', 'Pulmonary Arteries and Embolus Assessment', { rows: 7 }),
    section('rightHeart', 'Right Heart Strain Parameters', { rows: 4 }),
    section('lungsPleura', 'Lungs and Pleura', { rows: 6 }),
    section('mediastinum', 'Mediastinum and Other Findings', { rows: 4 }), ...standardClosing];
  if (lower.includes('coronary')) return [...opening,
    section('calcium', 'Coronary Calcium and Image Quality', { rows: 4 }),
    section('leftMainLad', 'Left Main and LAD', { rows: 6 }),
    section('lcx', 'LCx and Branches', { rows: 5 }),
    section('rca', 'RCA and Branches', { rows: 5 }),
    section('cardiacOther', 'Cardiac and Extra-Cardiac Findings', { rows: 5 }), ...standardClosing];
  if (lower.includes('abdomen') || lower.includes('kub') || lower.includes('ivp')) return [...opening,
    section('hepatobiliary', 'Liver, Gall Bladder and Biliary Tree', { rows: 5 }),
    section('pancreasSpleen', 'Pancreas and Spleen', { rows: 4 }),
    section('kidneysAdrenals', 'Kidneys and Adrenals', { rows: 6 }),
    section('uretersBladder', 'Ureters and Urinary Bladder', { rows: 5 }),
    section('bowelPeritoneum', 'Bowel, Peritoneum and Mesentery', { rows: 5 }),
    section('pelvisNodesVessels', 'Pelvic Organs, Nodes, Vessels and Bones', { rows: 5 }), ...standardClosing];
  if (lower.includes('lumbar spine')) return [...opening,
    section('alignmentBones', 'Alignment and Osseous Structures', { rows: 5 }),
    section('discsCanal', 'Discs, Canal and Neural Foramina', { rows: 7 }),
    section('levelFindings', 'Level-wise Findings', { rows: 8 }),
    section('paraspinal', 'Paraspinal Soft Tissues', { rows: 4 }), ...standardClosing];
  return [...opening,
    section('bonesAlignment', 'Bones and Alignment', { rows: 6 }),
    section('joint', 'Joint, Articular Surfaces and Cartilage', { rows: 5 }),
    section('softTissues', 'Muscles, Tendons and Soft Tissues', { rows: 6 }),
    section('neurovascular', 'Neurovascular Structures', { rows: 3 }), ...standardClosing];
};

const xraySections = (name) => {
  const lower = name.toLowerCase();
  const opening = [section('view', 'View / Projection', { rows: 2 }), section('clinicalInformation', 'Clinical Information', { rows: 2 })];
  if (lower.includes('chest')) return [...opening,
    section('lungs', 'Lung Fields', { rows: 5 }),
    section('pleura', 'Pleura and Costophrenic Angles', { rows: 3 }),
    section('cardiomediastinal', 'Cardiomediastinal Silhouette', { rows: 4 }),
    section('bonesSoftTissues', 'Bones and Soft Tissues', { rows: 4 }), ...standardClosing];
  if (lower.includes('pns')) return [...opening,
    section('sinuses', 'Paranasal Sinuses', { rows: 5 }),
    section('nasalCavity', 'Nasal Septum and Nasal Cavity', { rows: 3 }),
    section('facialBones', 'Facial Bones and Orbits', { rows: 4 }), ...standardClosing];
  if (lower.includes('lumbar')) return [...opening,
    section('alignment', 'Alignment and Curvature', { rows: 3 }),
    section('vertebrae', 'Vertebral Bodies and Posterior Elements', { rows: 5 }),
    section('discSpaces', 'Disc Spaces and End Plates', { rows: 4 }),
    section('softTissues', 'Paravertebral Soft Tissues', { rows: 3 }), ...standardClosing];
  return [...opening,
    section('bonesAlignment', 'Bones and Alignment', { rows: 5 }),
    section('jointSpaces', 'Joint Spaces and Articular Surfaces', { rows: 4 }),
    section('softTissues', 'Soft Tissues', { rows: 3 }), ...standardClosing];
};

const definitions = [
  {
    name: 'USG Anomaly Scan', category: 'Ultrasound', code: 'USG-ANOMALY',
    sections: [
      section('investigation', 'Investigation / Fetal Overview', { rows: 5 }),
      section('fetalEnvironment', 'FHR, Liquor, Placenta and Cervix', { rows: 4 }),
      section('head', 'Head and Intracranial Anatomy', { rows: 5 }),
      section('neckSpineFace', 'Neck, Spine and Face', { rows: 5 }),
      section('thoraxAbdomen', 'Thorax and Abdomen', { rows: 5 }),
      section('limbs', 'Limbs and Skeletal Survey', { rows: 4 }),
      ...standardClosing
    ],
    tables: [table('fetalBiometry', 'Fetal Biometry', ['Parameter', 'Measurement', 'Weeks', 'Days'], [
      ['BPD', '', '', ''], ['HC', '', '', ''], ['AC', '', '', ''], ['FL', '', '', ''], ['AUA', '', '', ''], ['EDD', '', '', '']
    ])]
  },
  {
    name: 'USG Whole Abdomen', category: 'Ultrasound', code: 'USG-WHOLE-ABD',
    sections: [
      section('hepatobiliary', 'Hepatobiliary System', { rows: 5 }),
      section('gallBladder', 'Gall Bladder, CBD and Portal Vein', { rows: 4 }),
      section('pancreas', 'Pancreas', { rows: 3 }),
      section('spleen', 'Spleen', { rows: 3 }),
      section('kidneys', 'Kidneys', { rows: 5 }),
      section('pelvis', 'Urinary Bladder and Pelvic Organs', { rows: 4 }),
      section('other', 'Other Findings', { rows: 3 }),
      ...standardClosing
    ]
  },
  {
    name: 'USG KUB', category: 'Ultrasound', code: 'USG-KUB',
    sections: [
      section('kidneys', 'Kidneys', { rows: 6 }),
      section('ureters', 'Ureters', { rows: 3 }),
      section('bladder', 'Urinary Bladder', { rows: 4 }),
      section('pelvicOrgans', 'Prostate / Uterus and Adnexa', { rows: 4 }),
      ...standardClosing
    ]
  },
  {
    name: 'USG Gravid Uterus - Color Doppler', category: 'Ultrasound', code: 'USG-GRAVID-DOPPLER',
    sections: [
      section('fetalOverview', 'Fetal Overview', { rows: 5 }),
      section('placentaLiquor', 'Placenta, Liquor and Cervix', { rows: 4 }),
      section('dopplerNarrative', 'Feto-Placental and Utero-Placental Circulation', { rows: 6 }),
      ...standardClosing
    ],
    tables: [
      table('fetalBiometry', 'Fetal Biometry', ['Parameter', 'Measurement', 'Weeks', 'Days'], [
        ['BPD', '', '', ''], ['HC', '', '', ''], ['AC', '', '', ''], ['FL', '', '', ''], ['AUA', '', '', ''], ['EDD / EFW', '', '', '']
      ]),
      table('dopplerParameters', 'Fetal Doppler Parameters', ['Vessel', 'Remark', 'RI', 'PI'], [
        ['Umbilical artery', '', '', ''], ['MCA', '', '', ''], ['Right uterine artery', '', '', ''], ['Left uterine artery', '', '', '']
      ])
    ]
  },
  {
    name: 'USG Renal Doppler', category: 'Ultrasound', code: 'USG-RENAL-DOPPLER',
    sections: [
      section('kidneys', 'Kidneys', { rows: 6 }),
      section('renalArteries', 'Color Doppler Evaluation of Bilateral Renal Arteries', { rows: 6 }),
      ...standardClosing
    ],
    tables: [table('renalDoppler', 'Renal Doppler Parameters', ['Level', 'Right Kidney', 'Left Kidney'], [
      ['At hilum', '', ''], ['Upper pole', '', ''], ['Mid pole', '', ''], ['Lower pole', '', '']
    ])]
  },
  {
    name: 'USG Bilateral Upper Limb', category: 'Ultrasound', code: 'USG-UPPER-LIMB-DOPPLER',
    sections: [section('indication', 'Indication', { rows: 2 }), section('rightLimb', 'Right Limb', { rows: 6 }), section('leftLimb', 'Left Limb', { rows: 6 }), ...standardClosing]
  },
  {
    name: 'USG Bilateral Lower Limb', category: 'Ultrasound', code: 'USG-LOWER-LIMB-DOPPLER',
    sections: [section('indication', 'Indication', { rows: 2 }), section('rightLimb', 'Right Limb', { rows: 6 }), section('leftLimb', 'Left Limb', { rows: 6 }), ...standardClosing]
  },
  {
    name: 'USG Both Breast', category: 'Ultrasound', code: 'USG-BOTH-BREAST',
    sections: [section('rightBreast', 'Right Breast', { rows: 6 }), section('leftBreast', 'Left Breast', { rows: 6 }), section('axillae', 'Axillae', { rows: 3 }), section('birads', 'BI-RADS Category', { rows: 2 }), ...standardClosing]
  },
  {
    name: 'Colour Doppler Penile', category: 'Ultrasound', code: 'DOPPLER-PENILE',
    sections: [section('indication', 'Indication', { rows: 2 }), section('technique', 'Technique', { rows: 4 }), section('findings', 'Findings', { rows: 7 }), ...standardClosing],
    tables: [table('penileDoppler', 'Spectral Waveform Parameters', ['Time Point', 'Right PSV', 'Right EDV', 'Left PSV', 'Left EDV'], [
      ['Pre injection', '', '', '', ''], ['5 minutes', '', '', '', ''], ['10 minutes', '', '', '', ''], ['15 minutes', '', '', '', '']
    ])]
  },
  {
    name: 'USG Chest', category: 'Ultrasound', code: 'USG-CHEST',
    sections: [section('pleura', 'Pleura and Pleural Spaces', { rows: 5 }), section('lungs', 'Visualized Lungs / Diaphragm', { rows: 4 }), section('other', 'Other Findings', { rows: 3 }), ...standardClosing]
  },
  {
    name: 'USG Doppler Rt Lower Limb - Deep Venous', category: 'Ultrasound', code: 'USG-RT-LL-DVT',
    aliases: ['USG Doppler Right Lower Limb Deep Venous'],
    sections: [section('indication', 'Indication', { rows: 2 }), section('deepVenousSystem', 'Deep Venous System', { rows: 8 }), section('superficialSystem', 'Superficial Venous System', { rows: 4 }), ...standardClosing]
  },
  {
    name: 'USG Doppler Right Lower Limb', category: 'Ultrasound', code: 'USG-RT-LOWER-LIMB',
    sections: [section('indication', 'Indication', { rows: 2 }), section('arterialSystem', 'Arterial System', { rows: 7 }), section('venousSystem', 'Venous System', { rows: 6 }), ...standardClosing]
  },
  {
    name: 'USG Obstetrics', category: 'Ultrasound', code: 'USG-OBSTETRICS',
    sections: [section('fetus', 'Fetus and Cardiac Activity', { rows: 5 }), section('placentaLiquor', 'Placenta, Liquor and Cervix', { rows: 4 }), section('maternal', 'Maternal Findings', { rows: 3 }), ...standardClosing],
    tables: [table('fetalBiometry', 'Fetal Biometry', ['Parameter', 'Measurement', 'Weeks', 'Days'], [
      ['BPD', '', '', ''], ['HC', '', '', ''], ['AC', '', '', ''], ['FL', '', '', ''], ['AUA', '', '', ''], ['EDD / EFW', '', '', '']
    ])]
  },
  {
    name: 'USG TVS', category: 'Ultrasound', code: 'USG-TVS', aliases: ['Ultrasound Pelvis TVS'],
    sections: [section('uterus', 'Uterus and Endometrium', { rows: 6 }), section('rightOvary', 'Right Ovary', { rows: 4 }), section('leftOvary', 'Left Ovary', { rows: 4 }), section('adnexaPouch', 'Adnexa and Pouch of Douglas', { rows: 4 }), ...standardClosing]
  },
  {
    name: 'NT Scan', category: 'Ultrasound', code: 'USG-NT-SCAN', aliases: ['Nuchal Translucency Scan'],
    sections: [section('fetalOverview', 'Fetal Overview', { rows: 5 }), section('nuchalMarkers', 'Nuchal and Aneuploidy Markers', { rows: 5 }), section('placentaLiquor', 'Placenta, Liquor and Cervix', { rows: 4 }), ...standardClosing],
    tables: [table('ntBiometry', 'Fetal Biometry', ['Parameter', 'Measurement', 'Gestational Age / Comment'], [
      ['CRL', '', ''], ['NT', '', ''], ['Nasal bone', '', ''], ['FHR', '', ''], ['EDD', '', '']
    ])]
  },
  ...[
    ['MRI Brain', 'MRI-BRAIN'], ['MRI Brachial Plexus', 'MRI-BRACHIAL-PLEXUS'], ['MRI Left Ankle', 'MRI-LEFT-ANKLE'],
    ['MRI Pelvis', 'MRI-PELVIS'], ['MRI Abdomen & Pelvis', 'MRI-ABDOMEN-PELVIS'], ['MRI Cervical Spine', 'MRI-CERVICAL-SPINE'],
    ['MRI CN VII and VIII Nerves', 'MRI-CN-VII-VIII'], ['MRI Enterography for IBD', 'MRI-ENTEROGRAPHY-IBD'], ['MRI Hip', 'MRI-HIP'],
    ['MRI Liver', 'MRI-LIVER'], ['MRI Lumbar Spine', 'MRI-LUMBAR-SPINE'], ['MRI Shoulder', 'MRI-SHOULDER'],
    ['MRI Wrist', 'MRI-WRIST'], ['MRI Elbow', 'MRI-ELBOW'], ['MRI Whole Spine', 'MRI-WHOLE-SPINE'], ['Foetal MRI', 'MRI-FOETAL']
  ].map(([name, code]) => ({ name, category: 'MRI', code, sections: mriSections(name) })),
  ...[
    ['CT Abdomen', 'CT-ABDOMEN'], ['CT Brain', 'CT-BRAIN'], ['CT Right Shoulder', 'CT-RIGHT-SHOULDER'],
    ['CT Right Ankle', 'CT-RIGHT-ANKLE'], ['CT PNS', 'CT-PNS'], ['CT Left Shoulder', 'CT-LEFT-SHOULDER'],
    ['CT Temporal Bone', 'CT-TEMPORAL-BONE'], ['CT Chest', 'CT-CHEST'], ['CT Virtual Bronchoscopy', 'CT-VIRTUAL-BRONCHOSCOPY'],
    ['CT KUB', 'CT-KUB'], ['CT Coronary Artery', 'CT-CORONARY-ARTERY'], ['CT Neck', 'CT-NECK'],
    ['CT Skull Base', 'CT-SKULL-BASE'], ['CT Facial Bones', 'CT-FACIAL-BONES'], ['CT Head Plain', 'CT-HEAD-PLAIN'],
    ['CT Wrist Plain', 'CT-WRIST-PLAIN'], ['CT Lumbar Spine Plain', 'CT-LUMBAR-SPINE-PLAIN'],
    ['CT Pulmonary Angiogram', 'CT-PULMONARY-ANGIOGRAM'], ['CT IVP', 'CT-IVP']
  ].map(([name, code]) => ({ name, category: name.includes('Coronary') || name.includes('Angiogram') ? 'Angiography' : 'CT Scan', code, sections: ctSections(name) })),
  ...[
    ['X-Ray Forearm', 'XRAY-FOREARM'], ['X-Ray Elbow Joint', 'XRAY-ELBOW'], ['X-Ray Chest', 'XRAY-CHEST'],
    ['X-Rays PNS Waters and Caldwell', 'XRAY-PNS-WATERS-CALDWELL'], ['X-Rays Lumbar Spine AP/LAT', 'XRAY-LUMBAR-SPINE-AP-LAT']
  ].map(([name, code]) => ({ name, category: 'X-Ray', code, sections: xraySections(name) }))
];

const templates = definitions.map((item, index) => ({
  number: index + 1,
  id: `radiology-${String(index + 1).padStart(3, '0')}-${slugify(item.name)}`,
  slug: slugify(item.name),
  name: item.name,
  code: item.code,
  category: item.category,
  aliases: item.aliases || [],
  version: '1.0',
  allowImages: true,
  maxImages: 6,
  sections: item.sections || genericCrossSectional,
  tables: item.tables || []
}));

module.exports = {
  version: '2026.07.20',
  source: 'Drlogy Radiology Reports Combined - 55 reference layouts',
  templates
};
