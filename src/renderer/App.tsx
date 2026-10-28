import { commitBeforeNavigation } from './lib/navigation'
import { Fragment, useCallback, useEffect, useState } from 'react'
import { Layout } from './components/Layout'
import { NAV_ITEMS, SIDEBAR_SHORTCUT_KEY, type Page } from './components/Sidebar'
import { ClipPage } from './pages/ClipPage'
import { LibraryPage } from './pages/LibraryPage'
import { JobsPage } from './pages/JobsPage'
import { SettingsPage } from './pages/SettingsPage'
import { AccountsPage } from './pages/AccountsPage'
import { PostsPage } from './pages/PostsPage'
import { AutomationsPage } from './pages/AutomationsPage'
import { AssistantPage } from './pages/AssistantPage'
import { MyClipperLogo } from './components/brand/MyClipperLogo'
import { useSettingsStore } from './store/use-settings-store'
import { useJobStore } from './store/use-job-store'
import { useSidebarStore } from './store/use-sidebar-store'
import { useUpdateStore } from './store/use-update-store'
import { useChangelogStore } from './store/use-changelog-store'
import { useAssistantStore } from './store/use-assistant-store'
import { useDataVersionStore } from './store/use-data-version-store'
import { usePostsStore } from './store/use-posts-store'
import { requestSettingsSection } from './lib/settings-focus'
import { ChangelogDialog } from './components/Changelog'
import { Button } from './components/ui/Button'
import { getApi } from './lib/ipc'

export default function App(): React.JSX.Element {
  const [loadError, setLoadError] = useState(false)
  const [retry, setRetry] = useState(0)
  const [page, setPage] = useState<Page>('clip')
  const [pageVisit, setPageVisit] = useState(0)
  const [libraryRun, setLibraryRun] = useState<{ outputDir: string; clipIndex?: number } | null>(null)
  const [showUpdates, setShowUpdates] = useState(0)

  const loadSettings = useSettingsStore((s) => s.load)
  const checkTools = useSettingsStore((s) => s.checkTools)
  const settingsLoaded = useSettingsStore((s) => s.loaded)
  const changelogOpen = useChangelogStore((s) => s.open)
  const closeChangelog = useCallback(() => useChangelogStore.getState().setOpen(false), [])

  const navigateRoot = useCallback((destination: Page): void => {
    if (document.querySelector('[role="dialog"][aria-modal="true"]')) return
    const go = (): void => {
      if (destination === 'jobs') useJobStore.getState().focusJob(null)
      setLibraryRun(null)
      setPage(destination)
      setPageVisit((visit) => visit + 1)
    }
    void commitBeforeNavigation().then(go, () => {
      if (window.confirm('Your latest clip edits could not be saved. Leave the editor and discard them?')) go()
    })
  }, [])

  useEffect(() => { if (page !== 'library') setLibraryRun(null) }, [page])
  const viewLibraryRun = useCallback((outputDir: string, clipIndex?: number): void => {
    setLibraryRun({ outputDir, clipIndex })
    setPage('library')
    setPageVisit((visit) => visit + 1)
  }, [])

  useEffect(() => {
    setLoadError(false)
    void loadSettings().then(() => checkTools()).catch(() => setLoadError(true))
  }, [loadSettings, checkTools, retry])

  useEffect(() => {
    const api = getApi()
    const unsubscribe = api.job.onUpdate((job) => useJobStore.getState().upsert(job))
    void api.job.list().then((jobs) => useJobStore.getState().hydrate(jobs)).catch(() => {})
    return unsubscribe
  }, [])

  useEffect(() => {
    const api = getApi()
    const assistant = useAssistantStore.getState()
    const unsubscribes = [
      api.assistant.onEvent((event) => useAssistantStore.getState().apply(event)),
      api.assistant.onStatus((status) => useAssistantStore.getState().applyStatus(status)),
      api.assistant.signIn.onState((state) => useAssistantStore.getState().applySignIn(state)),
      api.app.onDataChanged((scope) => {
        useDataVersionStore.getState().bump(scope)
        if (scope === 'settings') void useSettingsStore.getState().load().catch(() => {})
        if (scope === 'posts') void usePostsStore.getState().load().catch(() => {})
      }),
      api.app.onNavigate(({ page: destination, runDir }) => {
        if (runDir) viewLibraryRun(runDir)
        else navigateRoot(destination)
      })
    ]
    void assistant.init().catch(() => {})
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe())
  }, [navigateRoot, viewLibraryRun])

  const openAssistantSettings = useCallback((section: 'assistant' | 'keys' = 'assistant'): void => {
    requestSettingsSection(section)
    navigateRoot('settings')
  }, [navigateRoot])

  useEffect(() => {
    const api = getApi()
    const unsubscribes = [
      api.update.onState((state) => useUpdateStore.getState().set(state)),
      api.update.onShow(() => {
        setPage('settings')
        setShowUpdates((count) => count + 1)
      })
    ]
    void api.update.getState().then((state) => useUpdateStore.getState().set(state)).catch(() => {})
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe())
  }, [])

  useEffect(() => getApi().changelog?.onShow(() => {
    if (document.querySelector('[aria-modal="true"]')) return
    useChangelogStore.getState().setOpen(true)
  }), [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return
      if (e.key === SIDEBAR_SHORTCUT_KEY) {
        e.preventDefault()
        useSidebarStore.getState().toggle()
        return
      }
      const item = NAV_ITEMS.find((n) => n.shortcut === e.key)
      if (!item) return
      e.preventDefault()
      navigateRoot(item.id)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [navigateRoot])

  useEffect(() => {
    document.getElementById('page-scroll')?.scrollTo({ top: 0 })
  }, [page, pageVisit])

  return (
    <>
      {settingsLoaded ? (
        <Layout currentPage={page} onNavigate={navigateRoot}>
          <Fragment key={pageVisit}>
            {page === 'clip' && <ClipPage onNavigate={setPage} />}
            {page === 'library' && <LibraryPage onNavigate={setPage} initialRun={libraryRun?.outputDir} initialClipIndex={libraryRun?.clipIndex} />}
            {page === 'jobs' && <JobsPage onNavigate={setPage} onViewLibrary={viewLibraryRun} />}
            {page === 'assistant' && <AssistantPage onOpenSettings={openAssistantSettings} />}
            {page === 'accounts' && <AccountsPage onNavigate={setPage} />}
            {page === 'posts' && <PostsPage onNavigate={setPage} />}
            {page === 'automations' && <AutomationsPage onNavigate={setPage} onViewLibrary={viewLibraryRun} />}
            {page === 'settings' && <SettingsPage showUpdates={showUpdates} />}
          </Fragment>
        </Layout>
      ) : (
        <div className="app-backdrop drag flex h-screen items-center justify-center">
          {loadError ? (
            <div className="glass no-drag space-y-3 rounded-3xl px-5 py-5 text-center animate-pop-in">
              <p role="alert" className="text-sm text-danger">Could not load settings. Please try again.</p>
              <Button onClick={() => setRetry((value) => value + 1)}>Retry</Button>
            </div>
          ) : <MyClipperLogo className="h-7 animate-pulse opacity-80" />}
        </div>
      )}
      {changelogOpen && <ChangelogDialog onClose={closeChangelog} />}
    </>
  )
}
