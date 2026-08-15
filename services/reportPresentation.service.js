const DATE_TIME_KEYS = new Set([
  'registeredat',
  'reportedat',
  'releasedat',
  'samplecollectedat',
  'startedat',
  'completedat',
  'createdat',
  'updatedat',
  'eventdatetime'
]);

// ============================================
// Helpers
// ============================================

function normalizedKey(value = '') {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function valueOf(row, ...candidates) {
  if (!row) return undefined;

  for (const candidate of candidates.flat()) {
    if (candidate in row) return row[candidate];

    const wanted = normalizedKey(candidate);
    const actual = Object.keys(row).find((key) => normalizedKey(key) === wanted);

    if (actual) return row[actual];
  }

  return undefined;
}

function hasValue(value) {
  return value !== undefined && value !== null && value !== '' && value !== '—';
}

function scalar(value) {
  if (!hasValue(value)) return '—';

  if (value instanceof Date) return formatDate(value, true);

  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? value.toLocaleString('en-IN', { maximumFractionDigits: 2 })
      : '—';
  }

  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No';
  }

  if (Array.isArray(value)) {
    return value
      .map(scalar)
      .filter((item) => item !== '—')
      .join(', ') || '—';
  }

  if (typeof value === 'object') {
    for (const key of ['name', 'label', 'title', 'value']) {
      if (hasValue(value[key])) {
        return scalar(value[key]);
      }
    }

    return Object.entries(value)
      .filter(([, item]) => hasValue(item))
      .map(([key, item]) => `${humanize(key)}: ${scalar(item)}`)
      .join('; ') || '—';
  }

  return String(value);
}

function formatDate(value, withTime = false) {
  if (!hasValue(value)) return '—';

  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return scalar(value);
  }

  return date.toLocaleString('en-IN', withTime
    ? {
        timeZone: 'Asia/Kolkata',
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      }
    : {
        timeZone: 'Asia/Kolkata',
        day: '2-digit',
        month: 'short',
        year: 'numeric'
      }
  );
}

function humanize(value = '') {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function textPart(label, value, options = {}) {
  if (!hasValue(value)) return '';

  const text = options.date
    ? formatDate(value, options.time)
    : scalar(value);

  return options.bare ? text : `${label}: ${text}`;
}

function multiline(parts = []) {
  const rows = parts
    .flat()
    .filter(Boolean)
    .map((item) => String(item).trim())
    .filter(Boolean);

  return rows.length ? rows.join('\n') : '—';
}

function presentation(columns, rows) {
  return {
    columns: columns.map((column) => ({
      key: column.key,
      label: column.label,
      width: column.width
    })),
    rows: rows.map((row) =>
      Object.fromEntries(
        columns.map((column) => [column.key, column.value(row)])
      )
    )
  };
}

// ============================================
// Appointment Presentation
// ============================================

function appointmentPresentation(rows) {
  const columns = [
    {
      key: 'visit',
      label: 'Visit / Reference',
      width: 15,
      value: (row) => multiline([
        textPart('', valueOf(row, 'appointmentDate', 'date'), { date: true, bare: true }),
        textPart('Token', valueOf(row, 'token', 'appointmentNumber'))
      ])
    },
    {
      key: 'patient',
      label: 'Patient',
      width: 22,
      value: (row) => multiline([
        textPart('', valueOf(row, 'patient'), { bare: true }),
        textPart('UHID', valueOf(row, 'uhid')),
        [valueOf(row, 'mobile'), valueOf(row, 'ageGender')]
          .filter(hasValue)
          .map(scalar)
          .join(' · ')
      ])
    },
    {
      key: 'clinical',
      label: 'Doctor / Department',
      width: 18,
      value: (row) => multiline([
        textPart('', valueOf(row, 'doctor'), { bare: true }),
        textPart('', valueOf(row, 'department'), { bare: true }),
        textPart('', valueOf(row, 'careSetting'), { bare: true })
      ])
    },
    {
      key: 'visitDetails',
      label: 'Visit Details',
      width: 17,
      value: (row) => multiline([
        [valueOf(row, 'visitType'), valueOf(row, 'visitMode')]
          .filter(hasValue)
          .map(scalar)
          .join(' · '),
        textPart('Priority', valueOf(row, 'priority')),
        textPart('Source', valueOf(row, 'source'))
      ])
    },
    {
      key: 'schedule',
      label: 'Schedule / Location',
      width: 14,
      value: (row) => multiline([
        [valueOf(row, 'startTime'), valueOf(row, 'endTime')]
          .filter(hasValue)
          .map(scalar)
          .join(' – '),
        [valueOf(row, 'ward'), valueOf(row, 'bed')]
          .filter(hasValue)
          .map(scalar)
          .join(' / ')
      ])
    },
    {
      key: 'status',
      label: 'Status / Remarks',
      width: 14,
      value: (row) => multiline([
        textPart('', valueOf(row, 'status'), { bare: true }),
        textPart('Reason', valueOf(row, 'cancellationReason'))
      ])
    }
  ];

  return presentation(columns, rows);
}

// ============================================
// IPD Presentation
// ============================================

function ipdPresentation(rows, occupancy = false) {
  if (occupancy) {
    const columns = [
      {
        key: 'reference',
        label: 'IP / Admission',
        width: 18,
        value: (row) => multiline([
          textPart('', valueOf(row, '_id', 'admissionNumber'), { bare: true }),
          textPart('', valueOf(row, 'admissionDate'), { date: true, bare: true })
        ])
      },
      {
        key: 'patient',
        label: 'Patient',
        width: 23,
        value: (row) => multiline([
          textPart('', valueOf(row, 'patient'), { bare: true }),
          textPart('UHID', valueOf(row, 'uhid'))
        ])
      },
      {
        key: 'consultant',
        label: 'Consultant',
        width: 20,
        value: (row) => textPart('', valueOf(row, 'doctor'), { bare: true })
      },
      {
        key: 'location',
        label: 'Ward / Bed',
        width: 22,
        value: (row) => multiline([
          textPart('', valueOf(row, 'ward'), { bare: true }),
          textPart('Bed', valueOf(row, 'bed'))
        ])
      },
      {
        key: 'status',
        label: 'Status',
        width: 17,
        value: () => 'Occupied'
      }
    ];

    return presentation(columns, rows);
  }

  const columns = [
    {
      key: 'reference',
      label: 'IP / Dates',
      width: 17,
      value: (row) => multiline([
        textPart('', valueOf(row, 'admissionNumber', 'IP No.'), { bare: true }),
        textPart('Admit', valueOf(row, 'admissionDate', 'Admission Date'), { date: true }),
        textPart('Disch', valueOf(row, 'dischargeDate', 'Discharge Date'), { date: true })
      ])
    },
    {
      key: 'patient',
      label: 'Patient',
      width: 23,
      value: (row) => multiline([
        textPart('', valueOf(row, 'patient', 'Patient'), { bare: true }),
        textPart('UHID', valueOf(row, 'uhid', 'UHID')),
        [valueOf(row, 'mobile'), valueOf(row, 'ageGender'), valueOf(row, 'patientType')]
          .filter(hasValue)
          .map(scalar)
          .join(' · ')
      ])
    },
    {
      key: 'clinical',
      label: 'Doctor / Department',
      width: 18,
      value: (row) => multiline([
        textPart('', valueOf(row, 'doctor', 'Doctor'), { bare: true }),
        textPart('', valueOf(row, 'department', 'Department'), { bare: true })
      ])
    },
    {
      key: 'location',
      label: 'Location',
      width: 15,
      value: (row) => multiline([
        textPart('', valueOf(row, 'ward', 'Ward'), { bare: true }),
        [valueOf(row, 'room', 'Room'), valueOf(row, 'bed', 'Bed')]
          .filter(hasValue)
          .map(scalar)
          .join(' / ')
      ])
    },
    {
      key: 'status',
      label: 'Status / Medico',
      width: 13,
      value: (row) => multiline([
        textPart('', valueOf(row, 'status', 'Status'), { bare: true }),
        textPart('', valueOf(row, 'medicoStatus', 'Disposition'), { bare: true })
      ])
    },
    {
      key: 'discharge',
      label: 'Stay / Discharge',
      width: 14,
      value: (row) => multiline([
        textPart('LOS', valueOf(row, 'lengthOfStay')),
        textPart('', valueOf(row, 'dischargeReason'), { bare: true })
      ])
    }
  ];

  return presentation(columns, rows);
}

// ============================================
// Diagnostic Presentation
// ============================================

function diagnosticPresentation(rows) {
  const columns = [
    {
      key: 'request',
      label: 'Request / Date',
      width: 17,
      value: (row) => multiline([
        textPart('', valueOf(row, 'requestNumber'), { bare: true }),
        textPart('', valueOf(row, 'requestedDate'), { date: true, bare: true })
      ])
    },
    {
      key: 'patient',
      label: 'Patient',
      width: 21,
      value: (row) => multiline([
        textPart('', valueOf(row, 'patient'), { bare: true }),
        textPart('UHID', valueOf(row, 'uhid'))
      ])
    },
    {
      key: 'test',
      label: 'Test / Specimen',
      width: 20,
      value: (row) => multiline([
        textPart('', valueOf(row, 'test'), { bare: true }),
        textPart('Specimen', valueOf(row, 'specimen'))
      ])
    },
    {
      key: 'clinical',
      label: 'Doctor / Department',
      width: 17,
      value: (row) => multiline([
        textPart('', valueOf(row, 'doctor'), { bare: true }),
        textPart('', valueOf(row, 'department'), { bare: true })
      ])
    },
    {
      key: 'workflow',
      label: 'Workflow / TAT',
      width: 13,
      value: (row) => multiline([
        textPart('Collected', valueOf(row, 'sampleCollectedAt'), { date: true, time: true }),
        textPart('Reported', valueOf(row, 'reportedAt'), { date: true, time: true }),
        textPart('Released', valueOf(row, 'releasedAt'), { date: true, time: true }),
        textPart('TAT', hasValue(valueOf(row, 'turnaroundMinutes'))
          ? `${scalar(valueOf(row, 'turnaroundMinutes'))} min`
          : '')
      ])
    },
    {
      key: 'status',
      label: 'Status',
      width: 12,
      value: (row) => multiline([
        textPart('', valueOf(row, 'status'), { bare: true }),
        textPart('', valueOf(row, 'priority'), { bare: true })
      ])
    }
  ];

  return presentation(columns, rows);
}

// ============================================
// Billing Presentation
// ============================================

function billingPresentation(rows) {
  const columns = [
    {
      key: 'invoice',
      label: 'Invoice / Date',
      width: 18,
      value: (row) => multiline([
        textPart('', valueOf(row, 'invoiceNumber'), { bare: true }),
        textPart('', valueOf(row, 'issueDate'), { date: true, bare: true }),
        textPart('Encounter', valueOf(row, 'encounterNumber'))
      ])
    },
    {
      key: 'patient',
      label: 'Patient',
      width: 23,
      value: (row) => multiline([
        textPart('', valueOf(row, 'patient'), { bare: true }),
        textPart('UHID', valueOf(row, 'uhid')),
        textPart('Mobile', valueOf(row, 'mobile'))
      ])
    },
    {
      key: 'clinical',
      label: 'Doctor / Department',
      width: 17,
      value: (row) => multiline([
        textPart('', valueOf(row, 'doctor'), { bare: true }),
        textPart('', valueOf(row, 'department'), { bare: true })
      ])
    },
    {
      key: 'amounts',
      label: 'Financials',
      width: 23,
      value: (row) => multiline([
        textPart('Total', valueOf(row, 'total')),
        textPart('Paid', valueOf(row, 'amountPaid')),
        textPart('Balance', valueOf(row, 'balanceDue')),
        textPart('Discount', valueOf(row, 'discount'))
      ])
    },
    {
      key: 'status',
      label: 'Type / Status',
      width: 19,
      value: (row) => multiline([
        textPart('', valueOf(row, 'invoiceType'), { bare: true }),
        textPart('', valueOf(row, 'status'), { bare: true }),
        textPart('Due', valueOf(row, 'dueDate'), { date: true })
      ])
    }
  ];

  return presentation(columns, rows);
}

// ============================================
// OT Presentation
// ============================================

function otPresentation(rows) {
  const columns = [
    {
      key: 'request',
      label: 'Request / Schedule',
      width: 19,
      value: (row) => multiline([
        textPart('', valueOf(row, 'requestNumber'), { bare: true }),
        textPart('Requested', valueOf(row, 'requestedDate'), { date: true }),
        textPart('Scheduled', valueOf(row, 'scheduledDate'), { date: true, time: true })
      ])
    },
    {
      key: 'patient',
      label: 'Patient',
      width: 20,
      value: (row) => multiline([
        textPart('', valueOf(row, 'patient'), { bare: true }),
        textPart('UHID', valueOf(row, 'uhid'))
      ])
    },
    {
      key: 'procedure',
      label: 'Procedure / Surgeon',
      width: 22,
      value: (row) => multiline([
        textPart('', valueOf(row, 'procedure'), { bare: true }),
        textPart('', valueOf(row, 'surgeon', 'doctor'), { bare: true }),
        textPart('', valueOf(row, 'department'), { bare: true })
      ])
    },
    {
      key: 'theatre',
      label: 'OT / Timing',
      width: 20,
      value: (row) => multiline([
        textPart('Room', valueOf(row, 'otRoom')),
        textPart('Start', valueOf(row, 'startedAt'), { date: true, time: true }),
        textPart('End', valueOf(row, 'completedAt'), { date: true, time: true }),
        textPart('Duration', hasValue(valueOf(row, 'durationMinutes'))
          ? `${scalar(valueOf(row, 'durationMinutes'))} min`
          : '')
      ])
    },
    {
      key: 'status',
      label: 'Status / Billing',
      width: 19,
      value: (row) => multiline([
        textPart('', valueOf(row, 'status'), { bare: true }),
        textPart('Payment', valueOf(row, 'paymentStatus')),
        textPart('Total', valueOf(row, 'total'))
      ])
    }
  ];

  return presentation(columns, rows);
}

// ============================================
// Procedure Presentation
// ============================================

function procedurePresentation(rows) {
  const columns = [
    {
      key: 'request',
      label: 'Request / Schedule',
      width: 20,
      value: (row) => multiline([
        textPart('', valueOf(row, 'requestNumber'), { bare: true }),
        textPart('Requested', valueOf(row, 'requestedDate'), { date: true }),
        textPart('Scheduled', valueOf(row, 'scheduledDate'), { date: true, time: true })
      ])
    },
    {
      key: 'patient',
      label: 'Patient',
      width: 21,
      value: (row) => multiline([
        textPart('', valueOf(row, 'patient'), { bare: true }),
        textPart('UHID', valueOf(row, 'uhid'))
      ])
    },
    {
      key: 'procedure',
      label: 'Procedure',
      width: 22,
      value: (row) => textPart('', valueOf(row, 'procedure'), { bare: true })
    },
    {
      key: 'clinical',
      label: 'Doctor / Department',
      width: 20,
      value: (row) => multiline([
        textPart('', valueOf(row, 'doctor'), { bare: true }),
        textPart('', valueOf(row, 'department'), { bare: true })
      ])
    },
    {
      key: 'status',
      label: 'Status / Priority',
      width: 17,
      value: (row) => multiline([
        textPart('', valueOf(row, 'status'), { bare: true }),
        textPart('', valueOf(row, 'priority'), { bare: true }),
        textPart('Amount', valueOf(row, 'total'))
      ])
    }
  ];

  return presentation(columns, rows);
}

// ============================================
// Pharmacy Presentation
// ============================================

function pharmacyPresentation(rows) {
  const columns = [
    {
      key: 'prescription',
      label: 'Prescription / Date',
      width: 20,
      value: (row) => multiline([
        textPart('', valueOf(row, 'prescriptionNumber'), { bare: true }),
        textPart('', valueOf(row, 'issueDate'), { date: true, bare: true })
      ])
    },
    {
      key: 'patient',
      label: 'Patient',
      width: 23,
      value: (row) => multiline([
        textPart('', valueOf(row, 'patient'), { bare: true }),
        textPart('UHID', valueOf(row, 'uhid'))
      ])
    },
    {
      key: 'doctor',
      label: 'Doctor',
      width: 20,
      value: (row) => textPart('', valueOf(row, 'doctor'), { bare: true })
    },
    {
      key: 'items',
      label: 'Items / Dispensing',
      width: 20,
      value: (row) => multiline([
        textPart('Items', valueOf(row, 'itemCount')),
        textPart('Dispensed', valueOf(row, 'dispensedItems'))
      ])
    },
    {
      key: 'status',
      label: 'Source / Status',
      width: 17,
      value: (row) => multiline([
        textPart('', valueOf(row, 'sourceType'), { bare: true }),
        textPart('', valueOf(row, 'status'), { bare: true })
      ])
    }
  ];

  return presentation(columns, rows);
}

// ============================================
// Newborn Presentation
// ============================================

function newbornPresentation(rows) {
  const columns = [
    {
      key: 'date',
      label: 'Birth / Registration',
      width: 20,
      value: (row) => multiline([
        textPart('DOB', valueOf(row, 'dateOfBirth'), { date: true }),
        textPart('Registered', valueOf(row, 'registeredAt'), { date: true, time: true })
      ])
    },
    {
      key: 'patient',
      label: 'Patient',
      width: 25,
      value: (row) => multiline([
        textPart('', valueOf(row, 'patient'), { bare: true }),
        textPart('UHID', valueOf(row, 'uhid'))
      ])
    },
    {
      key: 'demographics',
      label: 'Demographics',
      width: 18,
      value: (row) => multiline([
        textPart('Gender', valueOf(row, 'gender')),
        textPart('Mobile', valueOf(row, 'mobile'))
      ])
    },
    {
      key: 'address',
      label: 'Address',
      width: 37,
      value: (row) => textPart('', valueOf(row, 'address'), { bare: true })
    }
  ];

  return presentation(columns, rows);
}

// ============================================
// Generic Presentation
// ============================================

function genericPresentation(rows, maxColumns = 6) {
  const keys = [
    ...new Set(
      rows
        .flatMap((row) => Object.keys(row || {}))
        .filter((key) => key !== '_id' && !key.startsWith('__'))
    )
  ];

  const selected = keys.slice(0, maxColumns);
  const width = selected.length ? Math.floor(100 / selected.length) : 100;

  const columns = selected.map((key, index) => ({
    key: `c${index}`,
    label: humanize(key),
    width: index === selected.length - 1
      ? 100 - width * (selected.length - 1)
      : width,
    value: (row) => {
      const value = valueOf(row, key);
      const normalized = normalizedKey(key);

      return DATE_TIME_KEYS.has(normalized) || /date$/.test(normalized)
        ? formatDate(value, DATE_TIME_KEYS.has(normalized))
        : scalar(value);
    }
  }));

  return presentation(columns, rows);
}

// ============================================
// MRD Presentation
// ============================================

function mrdPresentation(section, rows) {
  if (section === 'ipd-records' || section === 'discharges') {
    return ipdPresentation(rows, false);
  }

  if (section === 'opd-records') {
    return appointmentPresentation(rows);
  }

  if (section === 'incomplete') {
    const columns = [
      {
        key: 'record',
        label: 'IP / Discharge',
        width: 18,
        value: (row) => multiline([
          textPart('', valueOf(row, 'IP No.'), { bare: true }),
          textPart('', valueOf(row, 'Discharge Date'), { bare: true })
        ])
      },
      {
        key: 'patient',
        label: 'Patient',
        width: 22,
        value: (row) => multiline([
          textPart('', valueOf(row, 'Patient'), { bare: true }),
          textPart('UHID', valueOf(row, 'UHID'))
        ])
      },
      {
        key: 'clinical',
        label: 'Doctor / Department',
        width: 18,
        value: (row) => multiline([
          textPart('', valueOf(row, 'Doctor'), { bare: true }),
          textPart('', valueOf(row, 'Department'), { bare: true })
        ])
      },
      {
        key: 'review',
        label: 'Review',
        width: 14,
        value: (row) => multiline([
          textPart('', valueOf(row, 'Review Status'), { bare: true }),
          textPart('Open', valueOf(row, 'Open Deficiencies'))
        ])
      },
      {
        key: 'deficiencies',
        label: 'Deficiency Details',
        width: 28,
        value: (row) => textPart('', valueOf(row, 'Deficiency Details'), { bare: true })
      }
    ];

    return presentation(columns, rows);
  }

  if (section === 'documents' || section === 'archive') {
    const columns = [
      {
        key: 'date',
        label: 'Date',
        width: 13,
        value: (row) => textPart('', valueOf(row, 'Date'), { bare: true })
      },
      {
        key: 'patient',
        label: 'Patient',
        width: 23,
        value: (row) => multiline([
          textPart('', valueOf(row, 'Patient'), { bare: true }),
          textPart('UHID', valueOf(row, 'UHID'))
        ])
      },
      {
        key: 'document',
        label: 'Document',
        width: 25,
        value: (row) => multiline([
          textPart('', valueOf(row, 'Document'), { bare: true }),
          [valueOf(row, 'Category'), valueOf(row, 'Type')]
            .filter(hasValue)
            .map(scalar)
            .join(' · ')
        ])
      },
      {
        key: 'author',
        label: 'Author / Status',
        width: 18,
        value: (row) => multiline([
          textPart('', valueOf(row, 'Author'), { bare: true }),
          textPart('', valueOf(row, 'Status'), { bare: true })
        ])
      },
      {
        key: 'file',
        label: 'File / Archive Ref.',
        width: 21,
        value: (row) => textPart('', valueOf(row, 'File'), { bare: true })
      }
    ];

    return presentation(columns, rows);
  }

  if (section === 'file-tracking') {
    const columns = [
      {
        key: 'file',
        label: 'MRD File',
        width: 18,
        value: (row) => multiline([
          textPart('', valueOf(row, 'MRD File No.'), { bare: true }),
          textPart('', valueOf(row, 'Type'), { bare: true })
        ])
      },
      {
        key: 'patient',
        label: 'Patient',
        width: 23,
        value: (row) => multiline([
          textPart('', valueOf(row, 'Patient'), { bare: true }),
          textPart('UHID', valueOf(row, 'UHID'))
        ])
      },
      {
        key: 'holder',
        label: 'Current Holder',
        width: 24,
        value: (row) => textPart('', valueOf(row, 'Current Holder'), { bare: true })
      },
      {
        key: 'dates',
        label: 'Due / Updated',
        width: 19,
        value: (row) => multiline([
          textPart('Due', valueOf(row, 'Due')),
          textPart('Updated', valueOf(row, 'Last Updated'))
        ])
      },
      {
        key: 'status',
        label: 'Status',
        width: 16,
        value: (row) => textPart('', valueOf(row, 'Status'), { bare: true })
      }
    ];

    return presentation(columns, rows);
  }

  if (section === 'birth-death' || section === 'mortality') {
    const columns = [
      {
        key: 'record',
        label: 'Record / Event',
        width: 19,
        value: (row) => multiline([
          textPart('', valueOf(row, 'Record No.'), { bare: true }),
          textPart('', valueOf(row, 'Event Date / Time'), { bare: true }),
          textPart('', valueOf(row, 'Type'), { bare: true })
        ])
      },
      {
        key: 'patient',
        label: 'Patient',
        width: 23,
        value: (row) => multiline([
          textPart('', valueOf(row, 'Patient'), { bare: true }),
          textPart('UHID', valueOf(row, 'UHID')),
          textPart('Gender', valueOf(row, 'Gender'))
        ])
      },
      {
        key: 'clinical',
        label: 'Clinical / Cause',
        width: 27,
        value: (row) => textPart('', valueOf(row, 'Cause of Death'), { bare: true })
      },
      {
        key: 'certificate',
        label: 'Certificate',
        width: 16,
        value: (row) => textPart('', valueOf(row, 'Certificate'), { bare: true })
      },
      {
        key: 'status',
        label: 'Status',
        width: 15,
        value: (row) => textPart('', valueOf(row, 'Status'), { bare: true })
      }
    ];

    return presentation(columns, rows);
  }

  if (section === 'mlc') {
    const columns = [
      {
        key: 'case',
        label: 'MLC / Registered',
        width: 20,
        value: (row) => multiline([
          textPart('', valueOf(row, 'MLC No.'), { bare: true }),
          textPart('', valueOf(row, 'Registered'), { bare: true }),
          textPart('', valueOf(row, 'Case Type'), { bare: true })
        ])
      },
      {
        key: 'patient',
        label: 'Patient',
        width: 23,
        value: (row) => multiline([
          textPart('', valueOf(row, 'Patient'), { bare: true }),
          textPart('UHID', valueOf(row, 'UHID'))
        ])
      },
      {
        key: 'police',
        label: 'Police / FIR',
        width: 27,
        value: (row) => multiline([
          textPart('Station', valueOf(row, 'Police Station')),
          textPart('FIR', valueOf(row, 'FIR'))
        ])
      },
      {
        key: 'status',
        label: 'Status',
        width: 15,
        value: (row) => textPart('', valueOf(row, 'Status'), { bare: true })
      },
      {
        key: 'remarks',
        label: 'Remarks',
        width: 15,
        value: () => '—'
      }
    ];

    return presentation(columns, rows);
  }

  if (section === 'certificates') {
    const columns = [
      {
        key: 'certificate',
        label: 'Certificate',
        width: 20,
        value: (row) => multiline([
          textPart('', valueOf(row, 'Certificate No.'), { bare: true }),
          textPart('', valueOf(row, 'Type'), { bare: true }),
          textPart('', valueOf(row, 'Issue Date'), { bare: true })
        ])
      },
      {
        key: 'patient',
        label: 'Patient',
        width: 23,
        value: (row) => multiline([
          textPart('', valueOf(row, 'Patient'), { bare: true }),
          textPart('UHID', valueOf(row, 'UHID'))
        ])
      },
      {
        key: 'validity',
        label: 'Validity',
        width: 19,
        value: (row) => multiline([
          textPart('From', valueOf(row, 'Valid From')),
          textPart('To', valueOf(row, 'Valid To'))
        ])
      },
      {
        key: 'doctor',
        label: 'Authorized Doctor',
        width: 23,
        value: (row) => textPart('', valueOf(row, 'Authorized Doctor'), { bare: true })
      },
      {
        key: 'status',
        label: 'Status',
        width: 15,
        value: (row) => textPart('', valueOf(row, 'Status'), { bare: true })
      }
    ];

    return presentation(columns, rows);
  }

  return genericPresentation(rows);
}

// ============================================
// Build Report Presentation
// ============================================

function buildReportPresentation({
  context = 'mis',
  key = '',
  section = '',
  rows = []
} = {}) {
  const list = Array.isArray(rows) ? rows : [];

  if (context === 'mrd') {
    return mrdPresentation(section || key, list);
  }

  if ([
    'opd-visits',
    'opd-ipd-followup',
    'appointment-status',
    'opd-cancelled',
    'opd'
  ].includes(key)) {
    return appointmentPresentation(list);
  }

  if ([
    'ipd-admissions',
    'ipd-discharges',
    'ipd-deaths',
    'ipd-medico-status',
    'ipd'
  ].includes(key)) {
    return ipdPresentation(list, false);
  }

  if (key === 'ipd-bed-occupancy') {
    return ipdPresentation(list, true);
  }

  if (key === 'ipd-newborn') {
    return newbornPresentation(list);
  }

  if ([
    'lab-workload',
    'lab-tat',
    'lab',
    'radiology-workload',
    'radiology-tat',
    'radiology'
  ].includes(key)) {
    return diagnosticPresentation(list);
  }

  if ([
    'billing-revenue',
    'billing-refunds',
    'billing'
  ].includes(key)) {
    return billingPresentation(list);
  }

  if ([
    'ot-cases',
    'ot-utilisation',
    'ot'
  ].includes(key)) {
    return otPresentation(list);
  }

  if (key === 'procedure-workload') {
    return procedurePresentation(list);
  }

  if ([
    'pharmacy-activity',
    'pharmacy'
  ].includes(key)) {
    return pharmacyPresentation(list);
  }

  return genericPresentation(list);
}

module.exports = {
  buildReportPresentation,
  genericPresentation,
  humanize
};