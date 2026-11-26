/**
 * NEPHRO-SPECTRA — 3-tier role-based access control.
 *
 *   Patient                     → read-only own results, no raw traces, no CPT
 *   Nephrologist-Urologist Pro  → full clinical compute, vault writes, CPT audit
 *   Systems Architect Admin     → everything + runtime inspector, shader lab, vault wipe
 *
 * Privileges are declared as a capability matrix so every gate in the UI reads
 * from one source of truth. No TypeScript.
 */

import { computed, ref } from 'vue'

export const ROLES = {
  PATIENT: 'patient',
  PRO: 'pro',
  ADMIN: 'admin'
}

export const ROLE_META = {
  [ROLES.PATIENT]: {
    id: ROLES.PATIENT,
    name: 'Patient',
    badge: 'Tier I',
    tagline: 'Personal results, plain-language guidance',
    accent: '#5fb8a4',
    icon: 'user',
    description:
      'Read-only access to your own screening outputs. Simulators and illustrative panels stay live, but raw acoustic traces, vault writes and CPT quote auditing are withheld.'
  },
  [ROLES.PRO]: {
    id: ROLES.PRO,
    name: 'Nephrologist-Urologist Pro',
    badge: 'Tier II',
    tagline: 'Full clinical compute + billing audit',
    accent: '#8fb7ff',
    icon: 'stethoscope',
    description:
      'Every clinical engine, calibrated hardware capture, IndexedDB vault persistence, report export and the CPT quote auditor. Cannot alter shaders or wipe the vault.'
  },
  [ROLES.ADMIN]: {
    id: ROLES.ADMIN,
    name: 'Systems Architect Admin',
    badge: 'Tier III',
    tagline: 'Runtime, shaders, storage governance',
    accent: '#d8a5ff',
    icon: 'terminal',
    description:
      'Superset of Pro plus the Polyglot Runtime Inspector, live GLSL uniform control, vault maintenance and APK artefact provenance.'
  }
}

/** Capability matrix — single source of truth for every gate. */
export const CAPABILITIES = {
  patient: ['view:simulation', 'view:own-results', 'view:education', 'run:simulator-basic', 'view:apk'],
  pro: [
    'view:simulation', 'view:own-results', 'view:education', 'run:simulator-basic', 'view:apk',
    'run:full-engine', 'capture:microphone', 'capture:camera', 'write:vault', 'read:vault',
    'export:report', 'audit:cpt', 'view:raw-trace', 'view:ipss', 'calibrate:hardware',
    'view:billing'
  ],
  admin: [
    'view:simulation', 'view:own-results', 'view:education', 'run:simulator-basic', 'view:apk',
    'run:full-engine', 'capture:microphone', 'capture:camera', 'write:vault', 'read:vault',
    'export:report', 'audit:cpt', 'view:raw-trace', 'view:ipss', 'calibrate:hardware',
    'view:billing', 'view:runtime-inspector', 'control:shaders', 'wipe:vault', 'view:build-provenance',
    'toggle:hud', 'view:go-source'
  ]
}

export const CAPABILITY_LABELS = {
  'view:simulation': 'Live simulation',
  'view:own-results': 'Result viewing',
  'view:education': 'Clinical education',
  'run:simulator-basic': '1-Tap simulators',
  'view:apk': 'APK download',
  'run:full-engine': 'Full clinical engines',
  'capture:microphone': '48 kHz microphone capture',
  'capture:camera': 'Camera pad scanning',
  'write:vault': 'Vault write',
  'read:vault': 'Vault read',
  'export:report': 'Report export',
  'audit:cpt': 'CPT quote auditing',
  'view:raw-trace': 'Raw acoustic trace',
  'view:ipss': 'IPSS questionnaire',
  'calibrate:hardware': 'Hardware calibration',
  'view:billing': 'Billing panel',
  'view:runtime-inspector': 'Polyglot Runtime Inspector',
  'control:shaders': 'Shader uniform control',
  'wipe:vault': 'Vault maintenance',
  'view:build-provenance': 'Build provenance',
  'toggle:hud': 'Telemetry HUD',
  'view:go-source': 'Go source inspection'
}

const STORAGE_KEY = 'nephro-spectra.rbac.tier'

const role = ref(ROLES.PRO)

if (typeof localStorage !== 'undefined') {
  const saved = localStorage.getItem(STORAGE_KEY)
  if (saved && ROLE_META[saved]) role.value = saved
}

export function useRbac() {
  const capabilities = computed(() => new Set(CAPABILITIES[role.value] || []))
  const meta = computed(() => ROLE_META[role.value])
  const isPatient = computed(() => role.value === ROLES.PATIENT)
  const isPro = computed(() => role.value === ROLES.PRO)
  const isAdmin = computed(() => role.value === ROLES.ADMIN)

  function can(capability) {
    return capabilities.value.has(capability)
  }

  function assert(capability) {
    if (!can(capability)) {
      const err = new Error(`RBAC: '${capability}' requires a higher tier than ${meta.value.name}`)
      err.code = 'RBAC_DENIED'
      err.capability = capability
      throw err
    }
    return true
  }

  function setRole(next) {
    if (!ROLE_META[next]) return false
    role.value = next
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, next)
    return true
  }

  function cycleRole() {
    const order = [ROLES.PATIENT, ROLES.PRO, ROLES.ADMIN]
    const i = order.indexOf(role.value)
    setRole(order[(i + 1) % order.length])
  }

  /** Diff two tiers — powers the "what changes when I upgrade" drawer. */
  function diffTo(nextRole) {
    const a = new Set(CAPABILITIES[role.value] || [])
    const b = new Set(CAPABILITIES[nextRole] || [])
    return {
      gained: [...b].filter((c) => !a.has(c)),
      lost: [...a].filter((c) => !b.has(c))
    }
  }

  return {
    role,
    meta,
    isPatient,
    isPro,
    isAdmin,
    can,
    assert,
    setRole,
    cycleRole,
    diffTo,
    capabilities,
    allRoles: Object.values(ROLE_META),
    capabilityMatrix: CAPABILITIES
  }
}
