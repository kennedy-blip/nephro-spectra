<script setup>
/**
 * NEPHRO-SPECTRA — gooey metaball dock.
 *
 * The SVG filter `#nephro-gooey-dock` (feGaussianBlur → feColorMatrix alpha
 * threshold → feComposite) is applied ONLY to a dedicated blob layer sitting
 * behind the navigation. Labels and tooltips render in an unfiltered layer on
 * top, so the metaballs fuse without the text ever being eroded by the alpha
 * threshold.
 */
import { ref, computed } from 'vue'
import NephroIcon from './NephroIcon.vue'

const props = defineProps({
  items: { type: Array, required: true }, // [{ id, label, icon, wide }]
  active: { type: String, default: '' }
})
const emit = defineEmits(['select', 'action'])

const hoverId = ref('')
const hoverX = ref(0)
const dockEl = ref(null)

/** All keys in render order, so the blob layer matches the buttons exactly. */
const slots = computed(() => [
  ...props.items.map((i) => ({ key: i.id, icon: i.icon })),
  { key: 'apk', icon: 'phone' },
  { key: 'runtime', icon: 'cpu' }
])

function onEnter(e, id) {
  hoverId.value = id
  const host = dockEl.value
  if (host) {
    const rect = host.getBoundingClientRect()
    hoverX.value = e.clientX - rect.left
  }
  // Magnetic magnification: the hovered item rises, neighbours lift slightly.
  const el = e.currentTarget
  el.style.transition = 'transform 260ms cubic-bezier(0.34, 1.56, 0.64, 1)'
  el.style.transform = 'translateY(-7px) scale(1.14)'
}

function onLeave(e) {
  hoverId.value = ''
  e.currentTarget.style.transform = 'translateY(0) scale(1)'
}

function isBlobLit(key) {
  return hoverId.value === key || props.active === key
}
</script>

<template>
  <div ref="dockEl" class="gooey-dock-wrap">
    <!-- filter definition -->
    <svg width="0" height="0" aria-hidden="true" focusable="false" style="position: absolute">
      <defs>
        <filter id="nephro-gooey-dock" x="-40%" y="-40%" width="180%" height="200%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="8" result="blur" />
          <feColorMatrix
            in="blur"
            mode="matrix"
            values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 22 -9"
            result="goo"
          />
          <feComposite in="SourceGraphic" in2="goo" operator="atop" />
        </filter>
      </defs>
    </svg>

    <div class="gooey-dock">
      <!-- filtered metaball layer, behind the controls -->
      <div class="gooey-blobs" aria-hidden="true">
        <span
          v-for="slot in slots"
          :key="`blob-${slot.key}`"
          class="gooey-blob"
          :class="{ lit: isBlobLit(slot.key), ring: slot.key === active }"
        />
      </div>

      <!-- unfiltered controls on top -->
      <nav class="dock-nav" aria-label="Module navigation">
        <button
          v-for="item in items"
          :key="item.id"
          class="dock-item"
          :class="[{ active: active === item.id }, { 'wide-only': item.wide }]"
          :aria-current="active === item.id ? 'page' : undefined"
          :aria-label="item.label"
          @click="emit('select', item.id)"
          @pointerenter="onEnter($event, item.id)"
          @pointerleave="onLeave"
          @focus="hoverId = item.id"
          @blur="hoverId = ''"
        >
          <NephroIcon :name="item.icon" :size="21" />
          <span class="dock-tip">{{ item.label }}</span>
        </button>

        <span class="dock-sep" aria-hidden="true" />

        <button
          class="dock-item"
          aria-label="One-Tap APK"
          @click="emit('action', 'apk')"
          @pointerenter="onEnter($event, 'apk')"
          @pointerleave="onLeave"
        >
          <NephroIcon name="phone" :size="21" />
          <span class="dock-tip">One-Tap APK</span>
        </button>
        <button
          class="dock-item"
          aria-label="Polyglot runtime inspector"
          @click="emit('action', 'runtime')"
          @pointerenter="onEnter($event, 'runtime')"
          @pointerleave="onLeave"
        >
          <NephroIcon name="cpu" :size="21" />
          <span class="dock-tip">Polyglot Runtime</span>
        </button>
      </nav>
    </div>
  </div>
</template>

<style scoped>
.gooey-dock {
  position: relative;
  border-radius: 22px;
  background: var(--dock-bg);
  border: 1px solid var(--glass-border-strong);
  backdrop-filter: blur(var(--blur-heavy)) saturate(1.6);
  -webkit-backdrop-filter: blur(var(--blur-heavy)) saturate(1.6);
  box-shadow: 0 24px 60px -26px rgba(0, 0, 0, 0.92), inset 0 1px 0 var(--glass-highlight);
  padding: 9px 12px;
  isolation: isolate;
}

.gooey-blobs {
  position: absolute;
  inset: 7px 10px;
  display: flex;
  align-items: center;
  gap: 8px;
  pointer-events: none;
  filter: url(#nephro-gooey-dock);
  z-index: 0;
}

.gooey-blob {
  flex: 0 0 46px;
  width: 46px;
  height: 46px;
  border-radius: 15px;
  background: color-mix(in srgb, var(--accent) 30%, transparent);
  opacity: 0;
  transform: scale(0.72);
  transition: opacity 240ms var(--ease-out), transform 300ms cubic-bezier(0.34, 1.56, 0.64, 1);
}
/* the separator span is not a button, so keep its blob absent */
.gooey-blob.ring {
  opacity: 0.95;
  transform: scale(1);
  background: color-mix(in srgb, var(--accent) 62%, transparent);
}
.gooey-blob.lit {
  opacity: 0.8;
  transform: scale(1.16);
}

.dock-nav {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: flex-end;
  gap: 8px;
}

.dock-sep {
  width: 1px;
  align-self: stretch;
  margin: 6px 2px;
  background: var(--glass-border);
}
</style>
