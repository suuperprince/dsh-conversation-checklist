/**
 * Browser half of dsh-conversation-checklist.
 *
 * Two supported composer surfaces, both Session-scoped, so the button and the
 * panel are bound to the conversation on screen by the shell itself:
 *   `conversation.input.left`     — the three-line button beside the composer;
 *   `conversation.input.overlay`  — the compact panel that floats above it.
 *
 * No DOM injection, no core patch, no sidebar entry, and no use of the session
 * title or the selected chat as a key: every read and write carries `sessionId`.
 */

window.__ModuleLoader__.load({
  id: 'dsh-conversation-checklist',
  factory(require) {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement

    const API = '/api/dsh-conversation-checklist'
    const PANEL_WIDTH = 380
    const EMPTY = { phase: 'idle', checklist: null, tracking: true, error: null }

    // -- data store ------------------------------------------------------------
    // One stream for the conversation being watched. Switching conversations
    // closes the previous stream first, and every frame is checked against the
    // id it was opened for, so one conversation's data cannot land in another.
    function createDataStore() {
      let state = EMPTY
      let sessionId = null
      let source = null
      let generation = 0
      const subscribers = new Set()

      const emit = (next) => {
        state = next
        for (const fn of subscribers) fn()
      }

      const closeStream = () => {
        if (source !== null) {
          try {
            source.close()
          } catch {
            /* ignore */
          }
          source = null
        }
      }

      return {
        getSnapshot: () => state,
        subscribe(fn) {
          subscribers.add(fn)
          return () => subscribers.delete(fn)
        },
        view(nextSessionId) {
          const id = nextSessionId ? String(nextSessionId) : null
          if (id === sessionId) return
          sessionId = id
          const version = ++generation
          closeStream()
          if (id === null) {
            emit(EMPTY)
            return
          }
          emit({ ...EMPTY, phase: 'loading' })
          try {
            source = new EventSource(`${API}/stream?sessionId=${encodeURIComponent(id)}`)
            source.onmessage = (event) => {
              if (sessionId !== id || generation !== version) return
              let payload
              try {
                payload = JSON.parse(event.data)
              } catch {
                return
              }
              // Stale frame for a conversation that is no longer on screen.
              if (!payload || String(payload.sessionId) !== id) return
              emit({ phase: 'ready', checklist: payload, tracking: payload.tracking !== false, error: null })
            }
            source.onerror = () => {
              if (sessionId !== id || generation !== version) return
              emit({ ...state, error: 'Connection lost. Reconnecting…' })
            }
          } catch (error) {
            emit({ ...EMPTY, phase: 'error', error: String(error?.message ?? error) })
          }
        },
        async act(body) {
          if (sessionId === null) return
          const forSession = sessionId
          const version = generation
          try {
            const response = await fetch(`${API}/action`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ ...body, sessionId: forSession }),
            })
            const payload = await response.json().catch(() => null)
            // A reply that arrives after a switch belongs to the old panel.
            if (sessionId !== forSession || generation !== version) return
            if (response.ok && payload?.checklist?.sessionId === forSession) emit({ ...state, phase: 'ready', checklist: payload.checklist, error: null })
            else if (!response.ok) emit({ ...state, error: payload?.error ?? `http-${response.status}` })
          } catch (error) {
            if (sessionId !== forSession || generation !== version) return
            emit({ ...state, error: String(error?.message ?? error) })
          }
        },
        reset() {
          generation += 1
          sessionId = null
          closeStream()
          emit(EMPTY)
        },
        dispose() {
          generation += 1
          sessionId = null
          closeStream()
          subscribers.clear()
        },
      }
    }

    // -- open/anchor state -----------------------------------------------------
    // Keyed by Session, so opening another conversation starts closed and a
    // conversation's panel can never stay open over a different chat.
    function createUiStore() {
      let openFor = null
      let anchor = null
      let button = null
      // A stable snapshot object: useSyncExternalStore compares by identity, so
      // returning a fresh literal here re-renders forever and blanks the entry.
      let snapshot = { openFor: null, anchor: null }
      const subscribers = new Set()
      const emit = () => {
        snapshot = { openFor, anchor }
        for (const fn of subscribers) fn()
      }
      return {
        getSnapshot: () => snapshot,
        subscribe(fn) {
          subscribers.add(fn)
          return () => subscribers.delete(fn)
        },
        attach(element) {
          button = element
        },
        focusButton() {
          if (button instanceof HTMLElement) button.focus()
        },
        measure() {
          const element = button
          if (!(element instanceof HTMLElement) || !element.isConnected) return null
          const rect = element.getBoundingClientRect()
          return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
        },
        open(sessionId, rect) {
          openFor = String(sessionId)
          anchor = rect
          emit()
        },
        setAnchor(rect) {
          anchor = rect
          emit()
        },
        close() {
          if (openFor === null) return
          openFor = null
          anchor = null
          emit()
        },
        isOpen: (sessionId) => openFor !== null && openFor === String(sessionId),
      }
    }

    // -- styles ----------------------------------------------------------------
    const CSS = `
.ccl-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:6px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:0}
.ccl-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.ccl-btn[aria-expanded="true"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.ccl-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.ccl-panel{position:fixed;z-index:60;width:${PANEL_WIDTH}px;max-width:calc(100vw - 24px);max-height:min(56vh, 520px);display:flex;flex-direction:column;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;box-shadow:0 10px 34px rgba(0,0,0,.34);font-size:13px;overflow:hidden}
.ccl-head{display:flex;align-items:center;gap:6px;padding:9px 10px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.ccl-title{font-weight:600;font-size:13px;margin-right:auto}
.ccl-icon{width:22px;height:22px;border:1px solid transparent;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:12px;line-height:1;padding:0}
.ccl-icon:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.ccl-icon:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.ccl-icon[aria-pressed="true"]{color:var(--dsw-alias-brand-primary)}
.ccl-body{flex:1;min-height:0;overflow:auto;padding:6px 8px 10px}
.ccl-row{display:flex;align-items:flex-start;gap:6px;padding:3px 4px;border-radius:5px}
.ccl-row:hover{background:var(--dsw-alias-bg-layer-1)}
.ccl-twisty{width:14px;height:16px;flex:0 0 14px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:0;font-size:9px;line-height:14px}
.ccl-check{width:15px;height:15px;flex:0 0 15px;margin-top:2px;border-radius:50%;border:1.5px solid var(--dsw-alias-border-l2);background:transparent;cursor:pointer;padding:0;display:flex;align-items:center;justify-content:center;font-size:9px;line-height:1;color:var(--dsw-alias-bg-base)}
.ccl-check:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.ccl-check[data-status="done"]{background:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.ccl-check[data-status="blocked"]{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
.ccl-main{flex:1;min-width:0}
.ccl-text{display:block;line-height:1.35;word-break:break-word}
.ccl-text[data-status="done"]{color:var(--dsw-alias-label-secondary);text-decoration:line-through}
.ccl-meta{display:flex;gap:6px;flex-wrap:wrap;margin-top:1px;font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.ccl-meta[data-blocked="true"]{color:var(--dsw-alias-state-warn-primary)}
.ccl-actions{display:flex;gap:2px;opacity:0}
.ccl-row:hover .ccl-actions,.ccl-row:focus-within .ccl-actions{opacity:1}
.ccl-mini{font:inherit;font-size:10.5px;color:var(--dsw-alias-label-secondary);background:transparent;border:0;cursor:pointer;padding:1px 4px;border-radius:4px}
.ccl-mini:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.ccl-mini:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.ccl-input{font:inherit;width:100%;background:var(--dsw-alias-bg-layer-2);color:inherit;border:1px solid var(--dsw-alias-brand-primary);border-radius:5px;padding:2px 5px}
.ccl-section{margin:10px 2px 3px;font-size:10px;letter-spacing:.05em;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}
.ccl-empty{padding:14px 10px;color:var(--dsw-alias-label-secondary);line-height:1.5}
.ccl-error{margin:5px 2px;padding:5px 7px;border-radius:5px;border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);font-size:11.5px}
.ccl-sugg{display:flex;gap:5px;align-items:flex-start;padding:3px 5px;border-left:2px solid var(--dsw-alias-border-l2);margin:2px 0 2px 4px}
`

    function Styles() {
      return h('style', { 'data-dsh-conversation-checklist': '' }, CSS)
    }

    // -- button beside the composer -------------------------------------------
    function ComposerButton(props) {
      const sessionId = String(props.sessionId)
      const ui = props.ui
      const data = props.data
      const buttonRef = React.useRef(null)
      const open = React.useSyncExternalStore(ui.subscribe, ui.getSnapshot, ui.getSnapshot).openFor === sessionId

      // The shell keeps the button mounted per conversation; leaving closes it.
      React.useEffect(() => () => ui.close(), [ui, sessionId])

      React.useEffect(() => {
        ui.attach(buttonRef.current)
        return () => ui.attach(null)
      }, [ui])

      React.useEffect(() => {
        data.view(sessionId)
      }, [data, sessionId])

      const toggle = () => {
        if (open) {
          ui.close()
          return
        }
        const rect = buttonRef.current?.getBoundingClientRect()
        ui.open(sessionId, rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } : null)
      }

      return h(
        React.Fragment,
        null,
        h(Styles, null),
        h(
          'button',
          {
            ref: buttonRef,
            type: 'button',
            className: 'ccl-btn',
            'aria-label': 'Conversation checklist',
            'aria-haspopup': 'dialog',
            'aria-expanded': open,
            title: 'Conversation checklist',
            onClick: toggle,
          },
          h(
            'svg',
            {
              width: 16,
              height: 16,
              viewBox: '0 0 16 16',
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 1.6,
              strokeLinecap: 'round',
              'aria-hidden': true,
            },
            h('path', { d: 'M2.5 4.5h11' }),
            h('path', { d: 'M2.5 8h11' }),
            h('path', { d: 'M2.5 11.5h11' }),
          ),
        ),
      )
    }

    // -- anchored panel --------------------------------------------------------
    function ChecklistPanel(props) {
      const sessionId = String(props.sessionId)
      const ui = props.ui
      const data = props.data
      const snapshot = React.useSyncExternalStore(ui.subscribe, ui.getSnapshot, ui.getSnapshot)
      const state = React.useSyncExternalStore(data.subscribe, data.getSnapshot, data.getSnapshot)
      const panelRef = React.useRef(null)
      const [collapsed, setCollapsed] = React.useState({})
      const [renaming, setRenaming] = React.useState(null)
      // The panel's own `sessionId` prop can lag one frame behind a chat switch;
      // the store's `openFor` is the single conversation whose panel is open.
      const [anchor, setAnchor] = React.useState(snapshot.anchor)

      const open = snapshot.openFor !== null
      const checklist = state.checklist?.sessionId === sessionId ? state.checklist : null
      const tasks = checklist?.tasks ?? []
      React.useEffect(() => {
        setCollapsed({})
        setRenaming(null)
        data.view(sessionId)
      }, [sessionId, data])

      // Re-anchor when the shell moves the composer (resize, window scroll).
      React.useEffect(() => {
        if (!open) return
        const measure = () => {
          const rect = ui.measure()
          if (rect) setAnchor(rect)
        }
        measure()
        window.addEventListener('resize', measure)
        window.addEventListener('scroll', measure, true)
        return () => {
          window.removeEventListener('resize', measure)
          window.removeEventListener('scroll', measure, true)
        }
      }, [open])

      React.useEffect(() => {
        setAnchor(snapshot.anchor)
      }, [snapshot.anchor, snapshot.openFor, sessionId])

      // Escape closes from anywhere; pointerdown outside closes without ever
      // blocking the click, so the composer stays usable while it is open.
      React.useEffect(() => {
        if (!open) return
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            ui.close()
            ui.focusButton()
          }
        }
        const onPointerDown = (event) => {
          const target = event.target
          const panel = panelRef.current
          if (panel && target instanceof Node && panel.contains(target)) return
          if (target instanceof Element && target.closest('[aria-label="Conversation checklist"]')) return
          ui.close()
        }
        // Window capture runs before any document-level handler the composer
        // installs, so Escape closes the checklist rather than only its overlays.
        window.addEventListener('keydown', onKey, true)
        document.addEventListener('pointerdown', onPointerDown, true)
        return () => {
          window.removeEventListener('keydown', onKey, true)
          document.removeEventListener('pointerdown', onPointerDown, true)
        }
      }, [open, ui])

      if (!open) return null

      const position = (() => {
        const width = Math.min(PANEL_WIDTH, (typeof window === 'undefined' ? PANEL_WIDTH : window.innerWidth) - 24)
        const viewportWidth = typeof window === 'undefined' ? 1200 : window.innerWidth
        const viewportHeight = typeof window === 'undefined' ? 900 : window.innerHeight
        const left = anchor ? Math.min(Math.max(8, anchor.left), viewportWidth - width - 8) : 12
        const bottom = anchor ? Math.min(viewportHeight - 8, viewportHeight - anchor.top + 8) : 72
        return { left, bottom, width }
      })()

      const handle = (body) => data.act(body)
      const top = tasks.filter((t) => t.parentId === null && t.status !== 'dismissed')
      const childrenOf = (id) => tasks.filter((t) => t.parentId === id && t.status !== 'dismissed')

      const row = (task, depth) => {
        const kids = childrenOf(task.id)
        const isCollapsed = collapsed[task.id] === true
        return h(
          'div',
          { key: task.id },
          h(
            'div',
            { className: 'ccl-row', style: { paddingLeft: 4 + depth * 14 } },
            kids.length > 0
              ? h(
                  'button',
                  {
                    className: 'ccl-twisty',
                    type: 'button',
                    'aria-expanded': !isCollapsed,
                    'aria-label': `${isCollapsed ? 'Expand' : 'Collapse'} subtasks of ${task.text}`,
                    onClick: () => setCollapsed((c) => ({ ...c, [task.id]: !isCollapsed })),
                  },
                  isCollapsed ? '▶' : '▼',
                )
              : h('span', { className: 'ccl-twisty', 'aria-hidden': true }),
            h(
              'button',
              {
                className: 'ccl-check',
                type: 'button',
                'data-status': task.status,
                'aria-label': `${task.status === 'done' ? 'Reopen' : 'Complete'} ${task.text}`,
                title: task.status === 'done' ? 'Reopen' : 'Complete',
                onClick: () => handle({ kind: task.status === 'done' ? 'reopen' : 'complete', id: task.id }),
              },
              task.status === 'done' ? '✓' : task.status === 'blocked' ? '!' : '',
            ),
            h(
              'div',
              { className: 'ccl-main' },
              renaming === task.id
                ? h('input', {
                    className: 'ccl-input',
                    defaultValue: task.text,
                    autoFocus: true,
                    'aria-label': 'Task name',
                    onBlur: (event) => {
                      const text = event.target.value.trim()
                      if (text && text !== task.text) handle({ kind: 'rename', id: task.id, text })
                      setRenaming(null)
                    },
                    onKeyDown: (event) => {
                      if (event.key === 'Enter') event.target.blur()
                      if (event.key === 'Escape') {
                        event.stopPropagation()
                        event.target.value = task.text
                        setRenaming(null)
                      }
                    },
                  })
                : h(
                    'span',
                    {
                      className: 'ccl-text',
                      'data-status': task.status,
                      title: 'Double-click to rename',
                      onDoubleClick: () => setRenaming(task.id),
                    },
                    task.text,
                  ),
              h(
                'div',
                { className: 'ccl-meta', 'data-blocked': String(task.status === 'blocked') },
                task.status === 'blocked' && task.blockedBy ? h('span', null, `Waiting for: ${task.blockedBy}`) : null,
                kids.length > 0 ? h('span', null, `${kids.length} subtask${kids.length === 1 ? '' : 's'}`) : null,
                task.sourceRef ? h('span', null, task.sourceRef) : null,
              ),
            ),
            h(
              'div',
              { className: 'ccl-actions' },
              h('button', { className: 'ccl-mini', type: 'button', onClick: () => setRenaming(task.id) }, 'Rename'),
              h('button', { className: 'ccl-mini', type: 'button', onClick: () => handle({ kind: 'dismiss', id: task.id }) }, 'Dismiss'),
            ),
          ),
          kids.length > 0 && !isCollapsed ? kids.map((kid) => row(kid, depth + 1)) : null,
        )
      }

      // The composer card establishes a containing block, so a fixed panel would
      // be measured (and clipped) against it. DSH's own floating entries portal
      // to the document body for exactly this reason.
      const panel = h(
        'div',
        {
          ref: panelRef,
          className: 'ccl-panel',
          role: 'dialog',
          'aria-label': 'Conversation checklist',
          'aria-modal': 'false',
          style: position,
        },
        h(Styles, null),
        h(
          'div',
          { className: 'ccl-head' },
          h('span', { className: 'ccl-title' }, 'Conversation checklist'),
          h(
            'button',
            {
              className: 'ccl-icon',
              type: 'button',
              'aria-pressed': String(checklist?.tracking !== false),
              'aria-label': checklist?.tracking === false ? 'Turn tracking on' : 'Turn tracking off',
              title: checklist?.tracking === false ? 'Tracking off' : 'Tracking on',
              onClick: () => handle({ kind: 'set-tracking', tracking: !(checklist?.tracking !== false) }),
            },
            checklist?.tracking === false ? '○' : '●',
          ),
          h(
            'button',
            { className: 'ccl-icon', type: 'button', title: 'Rebuild from this conversation', 'aria-label': 'Rebuild from this conversation', onClick: () => handle({ kind: 'rebuild' }), disabled: !checklist || checklist.tracking === false },
            '↻',
          ),
          h('button', { className: 'ccl-icon', type: 'button', 'aria-label': 'Close checklist', title: 'Close', onClick: () => ui.close() }, '×'),
        ),
        h(
          'div',
          { className: 'ccl-body' },
          state.error ? h('div', { className: 'ccl-error' }, `Checklist error: ${state.error}`) : null,
          state.phase === 'loading' && tasks.length === 0 ? h('div', { className: 'ccl-empty' }, 'Loading checklist…') : null,
          state.phase === 'ready' && tasks.length === 0
            ? h(
                'div',
                { className: 'ccl-empty' },
                'No tasks in this conversation yet. Ask for something concrete and it appears here automatically.',
              )
            : null,
          top.map((task) => row(task, 0)),
          (checklist?.suggestions ?? []).length > 0
            ? [
                h('div', { key: 's', className: 'ccl-section' }, 'Suggestions'),
                ...(checklist.suggestions ?? []).map((suggestion) =>
                  h(
                    'div',
                    { key: suggestion.id, className: 'ccl-sugg' },
                    h('div', { className: 'ccl-main' }, h('span', { className: 'ccl-text' }, suggestion.text)),
                    h('button', { className: 'ccl-mini', type: 'button', onClick: () => handle({ kind: 'accept-suggestion', id: suggestion.id }) }, 'Accept'),
                    h('button', { className: 'ccl-mini', type: 'button', onClick: () => handle({ kind: 'dismiss-suggestion', id: suggestion.id }) }, 'Dismiss'),
                  ),
                ),
              ]
            : null,
          (checklist?.nativePlan?.todos ?? []).length > 0 || checklist?.nativePlan?.goal
            ? [
                h('div', { key: 'n', className: 'ccl-section' }, 'DSH plan'),
                checklist.nativePlan.goal
                  ? h('div', { key: 'g', className: 'ccl-sugg' }, h('div', { className: 'ccl-main' }, h('span', { className: 'ccl-text' }, checklist.nativePlan.goal.objective)))
                  : null,
                ...(checklist.nativePlan.todos ?? []).map((todo) =>
                  h(
                    'div',
                    { key: `t-${todo.id}`, className: 'ccl-sugg' },
                    h(
                      'div',
                      { className: 'ccl-main' },
                      h('span', { className: 'ccl-text', 'data-status': todo.status === 'completed' ? 'done' : 'todo' }, todo.content),
                    ),
                    h('button', { className: 'ccl-mini', type: 'button', onClick: () => handle({ kind: 'merge-native', id: todo.id }) }, 'Add'),
                  ),
                ),
              ]
            : null,
        ),
      )

      const host = typeof document === 'undefined' ? null : document.body
      return host === null ? panel : ReactDOM.createPortal(panel, host)
    }

    // -- plugin ----------------------------------------------------------------
    return {
      inject: ['slots'],
      apply(ctx) {
        const data = createDataStore()
        const ui = createUiStore()

        ctx.effect(() => () => data.dispose(), 'dsh-conversation-checklist.data')

        const stopButton = ctx.slots.inject('conversation.input.left', () =>
          ctx.slots.register(
            { name: 'conversation.input.left', id: 'conversation-checklist', order: 12, label: () => 'Conversation checklist' },
            (props) => h(ComposerButton, { ...props, data, ui }),
          ),
        )

        const stopPanel = ctx.slots.inject('conversation.input.overlay', () =>
          ctx.slots.register(
            { name: 'conversation.input.overlay', id: 'conversation-checklist', order: 12, label: () => 'Conversation checklist' },
            (props) => h(ChecklistPanel, { ...props, data, ui }),
          ),
        )

        ctx.effect(() => () => {
          stopButton?.()
          stopPanel?.()
          data.dispose()
        }, 'dsh-conversation-checklist.slots')
      },
    }
  },
})
