/**
 * Dashboard tiling layout powered by dockview-core.
 *
 * Each panel type is a widget with create/update/destroy lifecycle.
 * Widgets render into dockview panel elements and subscribe to SSE state updates.
 */
import { DockviewComponent } from 'dockview-core'
import 'dockview-core/dist/styles/dockview.css'

// --- Widget registry ---
// Each widget: { create(container, params), update(container, params, state), destroy(container) }
const WIDGETS = {}

export function registerWidget(name, widget) {
  WIDGETS[name] = widget
}

// --- Dockview setup ---
let dockview = null
let currentState = null
const panelInstances = new Map() // panelId -> { widget, container, params }

export function initLayout(rootElement) {
  dockview = new DockviewComponent({
    parentElement: rootElement,
    createComponent: (options) => {
      const widgetName = options.name
      const widget = WIDGETS[widgetName]
      if (!widget) {
        console.warn(`Unknown widget: ${widgetName}`)
        return { element: document.createElement('div') }
      }

      const element = document.createElement('div')
      element.className = `widget widget-${widgetName}`
      element.style.cssText = 'width:100%;height:100%;overflow:auto;'

      return {
        element,
        init(params) {
          const widgetParams = params.params || {}
          const instance = { widget, container: element, params: widgetParams }
          panelInstances.set(params.api.id, instance)
          widget.create(element, widgetParams)
          // If we already have state, do an initial update
          if (currentState) {
            widget.update(element, widgetParams, currentState)
          }
        },
        update(params) {
          const instance = panelInstances.get(params.api?.id)
          if (instance) {
            instance.params = params.params || instance.params
          }
        },
        dispose() {
          const id = [...panelInstances.entries()].find(([, v]) => v.container === element)?.[0]
          if (id) {
            const instance = panelInstances.get(id)
            if (instance?.widget.destroy) instance.widget.destroy(element)
            panelInstances.delete(id)
          }
        },
      }
    },
    className: 'fleet-dockview',
  })

  // Default layout
  const chatPanel = dockview.addPanel({
    id: 'chat-main',
    component: 'chat',
    title: 'Chat',
  })

  dockview.addPanel({
    id: 'search-main',
    component: 'search',
    title: 'Search',
    position: { referencePanel: chatPanel, direction: 'within' },
  })

  dockview.addPanel({
    id: 'terminal-main',
    component: 'terminal',
    title: 'Terminal',
    position: { referencePanel: chatPanel, direction: 'within' },
  })

  dockview.addPanel({
    id: 'timeline-main',
    component: 'timeline',
    title: 'Timeline',
    position: { referencePanel: chatPanel, direction: 'within' },
  })

  const agentsPanel = dockview.addPanel({
    id: 'agents-main',
    component: 'agents',
    title: 'Agents',
    position: { referencePanel: chatPanel, direction: 'right' },
  })

  dockview.addPanel({
    id: 'tasks-main',
    component: 'tasks',
    title: 'Tasks',
    position: { referencePanel: agentsPanel, direction: 'within' },
  })

  // Try to restore saved layout
  const saved = localStorage.getItem('fleet-layout')
  if (saved) {
    try {
      dockview.fromJSON(JSON.parse(saved))
    } catch (e) {
      console.warn('Failed to restore layout:', e)
    }
  }

  // Save layout on changes
  dockview.onDidLayoutChange(() => {
    try {
      localStorage.setItem('fleet-layout', JSON.stringify(dockview.toJSON()))
    } catch {}
  })

  // Focus chat by default
  chatPanel.api.setActive()

  return dockview
}

// Called on each SSE state update
export function updateState(state) {
  currentState = state
  for (const [id, instance] of panelInstances) {
    try {
      instance.widget.update(instance.container, instance.params, state)
    } catch (e) {
      console.warn(`Widget update error (${id}):`, e)
    }
  }
}

// Commands for the palette
export function splitPanel(direction, widgetName, params = {}) {
  if (!dockview) return
  const activePanel = dockview.activePanel
  if (!activePanel) return

  const id = `${widgetName}-${Date.now()}`
  dockview.addPanel({
    id,
    component: widgetName,
    title: widgetName.charAt(0).toUpperCase() + widgetName.slice(1),
    params,
    position: {
      referencePanel: activePanel,
      direction: direction === 'horizontal' ? 'below' : 'right',
    },
  })
}

export function closeActivePanel() {
  if (!dockview) return
  const activePanel = dockview.activePanel
  if (activePanel) {
    dockview.removePanel(activePanel)
  }
}

export function addTabToActive(widgetName, params = {}) {
  if (!dockview) return
  const activePanel = dockview.activePanel
  const id = `${widgetName}-${Date.now()}`
  const opts = {
    id,
    component: widgetName,
    title: widgetName.charAt(0).toUpperCase() + widgetName.slice(1),
    params,
  }
  if (activePanel) {
    opts.position = { referencePanel: activePanel, direction: 'within' }
  }
  dockview.addPanel(opts)
}

export function resetLayout() {
  localStorage.removeItem('fleet-layout')
  location.reload()
}

export { dockview }
