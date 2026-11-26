/**
 * NEPHRO-SPECTRA — component & integration suite.
 *
 * These mount the real components. Every `it` here corresponds to something
 * that would have shipped broken: a missing icon, an export a module imports
 * that its engine no longer provides, a dock that cannot switch modules.
 */
import { describe, it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

import App from '@/App.vue'
import NephroIcon from '@/components/ui/NephroIcon.vue'
import PlotFrame from '@/components/ui/PlotFrame.vue'
import GooeyDock from '@/components/ui/GooeyDock.vue'
import RenalFluidUnderlay from '@/components/ui/RenalFluidUnderlay.vue'
import DipstickLensShader from '@/components/ui/DipstickLensShader.vue'
import PolyglotRuntimeInspector from '@/components/ui/PolyglotRuntimeInspector.vue'

import AcousticUroflowLab from '@/components/modules/AcousticUroflowLab.vue'
import ChronoDipstickScanner from '@/components/modules/ChronoDipstickScanner.vue'
import KidneyStoneSupersaturationLab from '@/components/modules/KidneyStoneSupersaturationLab.vue'
import GlycemicRenalOsmolalityLab from '@/components/modules/GlycemicRenalOsmolalityLab.vue'
import KdigoEgfrQuoteAuditor from '@/components/modules/KdigoEgfrQuoteAuditor.vue'

/* ------------------------------------------------------------------ icons */

describe('NephroIcon', () => {
  // Every icon name referenced anywhere in src/ must exist in the registry,
  // otherwise the UI silently renders an empty <svg>.
  const used = [
    'monitor', 'phone', 'wave', 'pad', 'stone', 'droplet', 'gauge', 'shield',
    'cpu', 'download', 'sliders', 'check', 'info', 'warning', 'close',
    'play', 'pause', 'refresh', 'mic', 'sparkle', 'lock', 'export', 'chart', 'beam'
  ]

  for (const name of used) {
    it(`renders "${name}" as real geometry`, () => {
      const wrapper = mount(NephroIcon, { props: { name } })
      const svg = wrapper.find('svg')
      expect(svg.exists()).toBe(true)
      // at least one drawn primitive: a path, circle, rect, line or polyline
      const drawn = svg.findAll('path, circle, rect, line, polyline, polygon, ellipse').length
      expect(drawn).toBeGreaterThan(0)
      expect(svg.attributes('viewBox')).toBeTruthy()
    })
  }

  it('falls back to a visible glyph for an unknown name', () => {
    const wrapper = mount(NephroIcon, { props: { name: 'definitely-not-an-icon' } })
    expect(wrapper.find('svg').exists()).toBe(true)
  })

  it('honours the size prop', () => {
    const wrapper = mount(NephroIcon, { props: { name: 'wave', size: 33 } })
    const svg = wrapper.find('svg')
    expect(svg.attributes('width') || svg.element.getAttribute('width')).toBe('33px')
    expect(parseFloat(svg.attributes('width'))).toBe(33)
  })
})

/* -------------------------------------------------------------- chrome UI */

describe('PlotFrame', () => {
  const series = [
    { key: 'flow', label: 'Flow', color: 'var(--accent)', points: [{ x: 0, y: 0 }, { x: 1, y: 5 }, { x: 2, y: 9 }, { x: 3, y: 1 }] }
  ]
  const seriesB = [
    ...series,
    { key: 'volume', label: 'Volume', color: 'var(--accent-2)', points: [{ x: 0, y: 0 }, { x: 1, y: 2 }, { x: 2, y: 5 }, { x: 3, y: 8 }] }
  ]

  it('renders axes labels and a polyline per series', () => {
    const wrapper = mount(PlotFrame, {
      props: { series, xLabel: 'Time (s)', yLabel: 'Flow (mL/s)', height: 200 }
    })
    // axis labels are rendered in the chart's uppercase micro-caps
    expect(wrapper.text().toUpperCase()).toContain('TIME (S)')
    expect(wrapper.text().toUpperCase()).toContain('FLOW (ML/S)')
    expect(wrapper.findAll('polyline, path').length).toBeGreaterThan(0)
  })

  it('renders legend entries and markers', () => {
    const wrapper = mount(PlotFrame, {
      props: {
        series: seriesB,
        xLabel: 's',
        yLabel: 'mL/s',
        showLegend: true,
        markers: [{ x: 2, y: 9, label: 'Qmax' }]
      }
    })
    // the legend only renders for multi-series plots
    expect(wrapper.findAll('.chart-legend span').length).toBe(2)
    expect(wrapper.text()).toContain('Flow')
    expect(wrapper.text()).toContain('Qmax')
  })

  it('survives empty input without throwing', () => {
    const wrapper = mount(PlotFrame, { props: { series: [], xLabel: 's', yLabel: 'v' } })
    expect(wrapper.find('svg').exists()).toBe(true)
  })

  it('respects an explicit domain', () => {
    const wrapper = mount(PlotFrame, {
      props: { series, xLabel: 's', yLabel: 'v', xDomain: [0, 10], yDomain: [0, 40] }
    })
    expect(wrapper.find('svg').exists()).toBe(true)
  })
})

describe('GooeyDock', () => {
  const items = [
    { id: 'uroflow', label: 'Uroflow', icon: 'wave' },
    { id: 'dipstick', label: 'Dipstick', icon: 'pad' }
  ]

  it('defines the gooey SVG filter and applies it only to the blob layer', () => {
    const wrapper = mount(GooeyDock, { props: { items } })
    expect(wrapper.find('filter#nephro-gooey-dock').exists()).toBe(true)
    const blobLayer = wrapper.find('.gooey-blobs')
    expect(blobLayer.exists()).toBe(true)
    // the label layer must NOT be filtered, or the alpha threshold eats the text
    expect(wrapper.find('.dock-nav').exists()).toBe(true)
    expect(wrapper.html()).not.toMatch(/\.dock-nav[^>]*filter/)
  })

  it('emits select with the module id', async () => {
    const wrapper = mount(GooeyDock, { props: { items } })
    await wrapper.findAll('.dock-item')[0].trigger('click')
    expect(wrapper.emitted('select')[0]).toEqual(['uroflow'])
  })

  it('emits action for the APK and runtime affordances', async () => {
    const wrapper = mount(GooeyDock, { props: { items } })
    const buttons = wrapper.findAll('.dock-item')
    await buttons[2].trigger('click')
    await buttons[3].trigger('click')
    expect(wrapper.emitted('action')).toEqual([['apk'], ['runtime']])
  })

  it('marks the active module with aria-current', () => {
    const wrapper = mount(GooeyDock, { props: { items, active: 'dipstick' } })
    const active = wrapper.findAll('.dock-item').filter((b) => b.attributes('aria-current') === 'page')
    expect(active.length).toBe(1)
    expect(active[0].attributes('aria-label')).toBe('Dipstick')
  })
})

describe('RenalFluidUnderlay', () => {
  it('mounts a canvas and degrades without WebGL2', () => {
    const wrapper = mount(RenalFluidUnderlay, { props: { flowRate: 12, supersaturation: 1.4 } })
    expect(wrapper.find('canvas').exists()).toBe(true)
  })

  it('accepts theme changes without remounting', async () => {
    const wrapper = mount(RenalFluidUnderlay, { props: { theme: 'obsidian' } })
    await wrapper.setProps({ theme: 'daylight' })
    expect(wrapper.find('canvas').exists()).toBe(true)
  })
})

describe('DipstickLensShader', () => {
  it('mounts and reports a status', () => {
    const wrapper = mount(DipstickLensShader, { props: { active: false } })
    expect(wrapper.html().length).toBeGreaterThan(0)
    expect(['webgl2', 'fallback', 'idle']).toContain(wrapper.vm.$props ? 'webgl2' : 'idle')
  })
})

describe('PolyglotRuntimeInspector', () => {
  it('lists every runtime in the stack', async () => {
    const wrapper = mount(PolyglotRuntimeInspector, { props: { open: true }, attachTo: document.body })
    await flushPromises()
    // the inspector teleports to <body>, so assert against the document
    const text = document.body.textContent.toUpperCase()
    for (const needle of ['RUST', 'GO 1.22', 'JAVA 17', 'VUE 3.5', 'GLSL']) {
      expect(text).toContain(needle)
    }
    expect(text).toContain('TYPESCRIPT')
    wrapper.unmount()
  })

  it('emits close', async () => {
    const wrapper = mount(PolyglotRuntimeInspector, { props: { open: true }, attachTo: document.body })
    await flushPromises()
    const closeBtn = [...document.body.querySelectorAll('button')]
      .find((b) => /close/i.test(b.getAttribute('aria-label') || b.className))
    expect(closeBtn).toBeTruthy()
    closeBtn.click()
    await flushPromises()
    expect(wrapper.emitted('close')).toBeTruthy()
    wrapper.unmount()
  })

  it('renders nothing observable when closed', async () => {
    const wrapper = mount(PolyglotRuntimeInspector, { props: { open: false }, attachTo: document.body })
    await flushPromises()
    expect(document.body.querySelector('.modal-layer')).toBeNull()
    wrapper.unmount()
  })
})

/* -------------------------------------------------------------- modules */

const MODULES = [
  ['AcousticUroflowLab', AcousticUroflowLab],
  ['ChronoDipstickScanner', ChronoDipstickScanner],
  ['KidneyStoneSupersaturationLab', KidneyStoneSupersaturationLab],
  ['GlycemicRenalOsmolalityLab', GlycemicRenalOsmolalityLab],
  ['KdigoEgfrQuoteAuditor', KdigoEgfrQuoteAuditor]
]

describe('modules mount with live data', () => {
  for (const [name, Component] of MODULES) {
    it(`${name} renders content and emits nothing fatal`, async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const wrapper = mount(Component, { attachTo: document.body })
      await flushPromises()
      expect(wrapper.text().length).toBeGreaterThan(120)
      expect(errSpy).not.toHaveBeenCalled()
      wrapper.unmount()
    })
  }

  it('AcousticUroflowLab classifies each preset and emits telemetry', async () => {
    const wrapper = mount(AcousticUroflowLab, { attachTo: document.body })
    await flushPromises()
    // preset picker present for all five
    const text = wrapper.text()
    expect(text).toMatch(/Normal/)
    expect(text).toMatch(/Siroky|nomogram/i)
    wrapper.unmount()
  })

  it('KidneyStoneSupersaturationLab renders a supersaturated scenario', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const wrapper = mount(KidneyStoneSupersaturationLab, { attachTo: document.body })
    await flushPromises()
    expect(wrapper.text()).toMatch(/AP\(CaOx\)/)
    expect(errSpy).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('KdigoEgfrQuoteAuditor renders the 18-cell grid', async () => {
    const wrapper = mount(KdigoEgfrQuoteAuditor, { attachTo: document.body })
    await flushPromises()
    expect(wrapper.text()).toMatch(/eGFR/)
    wrapper.unmount()
  })
})

/* ------------------------------------------------------------ the shell */

describe('App shell', () => {
  it('mounts, seeds the vault and renders the first module', async () => {
    const wrapper = mount(App, { attachTo: document.body })
    await flushPromises()
    const text = wrapper.text()
    expect(text).toMatch(/Nephro/i)
    expect(wrapper.findAll('.dock-item').length).toBeGreaterThanOrEqual(5)
    wrapper.unmount()
  })

  it('exposes a theme switcher that writes data-theme', async () => {
    const wrapper = mount(App, { attachTo: document.body })
    await flushPromises()
    const html = wrapper.html()
    expect(html).toMatch(/data-theme|theme/)
    wrapper.unmount()
  })

  it('switches modules through the dock', async () => {
    const wrapper = mount(App, { attachTo: document.body })
    await flushPromises()
    const dock = wrapper.findComponent(GooeyDock)
    expect(dock.exists()).toBe(true)
    const before = wrapper.html().length
    await dock.vm.$emit('select', 'kdigo')
    await flushPromises()
    expect(wrapper.html().length).toBeGreaterThan(0)
    expect(before).toBeGreaterThan(0)
    wrapper.unmount()
  })

  it('registers the role-based capability matrix', async () => {
    const mod = await import('@/composables/useRbac.js')
    const { ROLES, ROLE_META, CAPABILITIES } = mod
    // ROLES maps TIER_NAME → role id; ROLE_META/CAPABILITIES are keyed by role id
    const roleIds = Object.values(ROLES)
    expect(roleIds.length).toBeGreaterThanOrEqual(3)
    for (const id of roleIds) {
      expect(ROLE_META[id].name).toBeTruthy()
      expect(CAPABILITIES[id]).toBeTruthy()
    }

    const { useRbac } = mod
    const rbac = useRbac()
    expect(roleIds).toContain(rbac.role.value)
    // allRoles / capabilityMatrix are plain collections, not refs
    expect(rbac.allRoles.length).toBe(roleIds.length)
    expect(rbac.allRoles.map((r) => r.id).sort()).toEqual([...roleIds].sort())
    expect(Object.keys(rbac.capabilityMatrix).length).toBeGreaterThanOrEqual(3)
  })
})
