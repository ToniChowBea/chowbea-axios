/**
 * Template generators for Vite plugin registry files.
 *
 * Each function returns the full file content as a string. Functions that
 * accept `importPrefix` use it for project-specific path aliases (e.g. "@/",
 * "~/") in import statements.
 *
 * These are written to the user's project during `chowbea init
 * --with-vite-plugins` and are meant to be user-customizable after scaffolding.
 */

// ---------------------------------------------------------------------------
// Shared: use-mobile hook
// ---------------------------------------------------------------------------

export function generateUseMobileHookContent(): string {
  return `import * as React from 'react'

const MOBILE_BREAKPOINT = 768

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined)

  React.useEffect(() => {
    const mql = window.matchMedia(\`(max-width: \${MOBILE_BREAKPOINT - 1}px)\`)
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    }
    mql.addEventListener('change', onChange)
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  return !!isMobile
}
`;
}

// ---------------------------------------------------------------------------
// Surfaces: define-surface.ts
// ---------------------------------------------------------------------------

export function generateDefineSurfaceContent(): string {
  return `// Runtime store — populated by defineSurface() calls at module import time
const _defaults = new Map<string, Record<string, unknown>>()

export type SurfaceVariant = 'dialog' | 'alert'

export interface SurfaceHandle<
  T extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly id: string
  readonly defaults: T
  readonly variant: SurfaceVariant
  readonly closeOnAction: boolean
}

/**
 * Register a surface and return a typed handle.
 *
 * @example
 * export const CreateStaff = defineSurface('create-staff', {
 *   campusId: '',
 *   isFirst: false,
 * })
 *
 * // Alert-style surface (renders AlertDialog on desktop):
 * export const ConfirmDelete = defineSurface('confirm-delete', {
 *   title: 'Delete?',
 * }, { variant: 'alert' })
 */
export function defineSurface<const T extends Record<string, unknown>>(
  id: string,
  defaults: T,
  config?: { variant?: SurfaceVariant; closeOnAction?: boolean },
): SurfaceHandle<T> {
  _defaults.set(id, defaults)
  return {
    id,
    defaults,
    variant: config?.variant ?? 'dialog',
    closeOnAction: config?.closeOnAction ?? true,
  }
}

/** Runtime lookup used by the Zustand store */
export function getSurfaceDefaults(id: string): Record<string, unknown> {
  return _defaults.get(id) ?? {}
}
`;
}

// ---------------------------------------------------------------------------
// Surfaces: surface.registry.ts
// ---------------------------------------------------------------------------

export function generateSurfaceRegistryContent(): string {
  return `import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { getSurfaceDefaults } from './define-surface'
import type { SurfaceHandle } from './define-surface'

interface CloseConfig {
  clearProps?: boolean
}

interface SurfaceState {
  openSurfaces: Record<string, boolean>
  props: Record<string, Record<string, unknown> | undefined>
  openCount: Record<string, number>

  openSurface: <T extends Record<string, unknown>>(
    surface: SurfaceHandle<T>,
    config?: { props?: Partial<T> },
  ) => void
  closeSurface: (surface: SurfaceHandle, config?: CloseConfig) => void
  isOpen: (surface: SurfaceHandle) => boolean
  getProps: <T extends Record<string, unknown>>(surface: SurfaceHandle<T>) => T
  getOpenCount: (surface: SurfaceHandle) => number
  onOpenChange: (
    surface: SurfaceHandle,
    config?: CloseConfig,
  ) => (open: boolean) => void
}

export const useSurface = create<SurfaceState>()(
  persist(
    (set, get) => ({
      openSurfaces: {},
      props: {},
      openCount: {},

      openSurface: (surface, config) => {
        set((state) => ({
          openSurfaces: { ...state.openSurfaces, [surface.id]: true },
          props: { ...state.props, [surface.id]: config?.props },
          openCount: {
            ...state.openCount,
            [surface.id]: (state.openCount[surface.id] ?? 0) + 1,
          },
        }))
      },

      closeSurface: (surface, config) =>
        set((state) => ({
          openSurfaces: { ...state.openSurfaces, [surface.id]: false },
          // Keep props during close so the exit animation doesn't flash defaults.
          // Props are overwritten on the next openSurface() call.
          props:
            config?.clearProps === true
              ? { ...state.props, [surface.id]: undefined }
              : state.props,
        })),

      isOpen: (surface) => get().openSurfaces[surface.id] ?? false,

      getOpenCount: (surface) => get().openCount[surface.id] ?? 0,

      getProps: <T extends Record<string, unknown>>(
        surface: SurfaceHandle<T>,
      ) => {
        const stored = get().props[surface.id]
        const defaults = getSurfaceDefaults(surface.id)
        return { ...defaults, ...surface.defaults, ...stored } as T
      },

      onOpenChange: (surface, config) => (open) => {
        if (open) {
          set((state) => ({
            openSurfaces: { ...state.openSurfaces, [surface.id]: true },
          }))
        } else {
          get().closeSurface(surface, config)
        }
      },
    }),
    {
      name: 'surface-registry',
      storage: createJSONStorage(() => sessionStorage),
    },
  ),
)
`;
}

// ---------------------------------------------------------------------------
// Surfaces: surface.tsx (compound components)
// ---------------------------------------------------------------------------

export function generateSurfaceComponentsContent(
  importPrefix: string,
): string {
  return `import * as React from 'react'
import { useSurface } from './surface.registry'
import type { SurfaceHandle, SurfaceVariant } from './define-surface'
import { Button } from '${importPrefix}components/ui/button'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '${importPrefix}components/ui/alert-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '${importPrefix}components/ui/dialog'
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from '${importPrefix}components/ui/drawer'
import { ScrollArea } from '${importPrefix}components/ui/scroll-area'
import { useIsMobile } from '${importPrefix}hooks/use-mobile'
import { cn } from '${importPrefix}lib/utils'

// Context to share mobile state, variant, and surface identity across all Surface components
interface SurfaceContextValue {
  isMobile: boolean
  surface: SurfaceHandle
  variant: SurfaceVariant
  closeOnAction: boolean
  openCount: number
}

const SurfaceContext = React.createContext<SurfaceContextValue | null>(null)

function useSurfaceContext() {
  const ctx = React.useContext(SurfaceContext)
  if (!ctx) {
    throw new Error(
      'Surface compound components must be used within a <SurfaceContainer>',
    )
  }
  return ctx
}

/** True when the surface should render alert-dialog primitives (alert variant on desktop) */
function useIsAlert() {
  const { isMobile, variant } = useSurfaceContext()
  return !isMobile && variant === 'alert'
}

interface SurfaceContainerProps {
  surface: SurfaceHandle
  children?: React.ReactNode
}

interface SurfaceTriggerProps {
  children?: React.ReactNode
  className?: string
  asChild?: boolean
}

interface SurfaceContentProps {
  children?: React.ReactNode
  className?: string
  showCloseButton?: boolean
}

interface SurfaceTextProps {
  children?: React.ReactNode
  className?: string
}

// SurfaceContainer - provides context and renders Dialog/Drawer/AlertDialog
function SurfaceContainer({ children, surface }: SurfaceContainerProps) {
  const isMobile = useIsMobile()
  const Component = isMobile
    ? Drawer
    : surface.variant === 'alert'
      ? AlertDialog
      : Dialog
  const { isOpen, onOpenChange, getOpenCount } = useSurface()

  return (
    <SurfaceContext.Provider
      value={{
        isMobile,
        surface,
        variant: surface.variant,
        closeOnAction: surface.closeOnAction,
        openCount: getOpenCount(surface),
      }}
    >
      <Component
        data-slot="surface-container"
        open={isOpen(surface)}
        onOpenChange={onOpenChange(surface)}
      >
        {children}
      </Component>
    </SurfaceContext.Provider>
  )
}

function SurfaceTrigger({ children, ...props }: SurfaceTriggerProps) {
  const { isMobile } = useSurfaceContext()
  const isAlert = useIsAlert()
  const Component = isMobile
    ? DrawerTrigger
    : isAlert
      ? AlertDialogTrigger
      : DialogTrigger

  return (
    <Component data-slot="surface-trigger" {...props}>
      {children}
    </Component>
  )
}

function SurfaceContent({
  children,
  className,
  showCloseButton,
  ...props
}: SurfaceContentProps) {
  const { isMobile, openCount } = useSurfaceContext()
  const isAlert = useIsAlert()

  // Key children by openCount so internal state resets on each open
  const keyedChildren = (
    <React.Fragment key={openCount}>{children}</React.Fragment>
  )

  if (isMobile) {
    return (
      <DrawerContent
        className={cn('p-4', className)}
        data-slot="surface-content"
        {...props}
      >
        {keyedChildren}
      </DrawerContent>
    )
  }

  if (isAlert) {
    return (
      <AlertDialogContent
        className={cn(className)}
        data-slot="surface-content"
        {...props}
      >
        {keyedChildren}
      </AlertDialogContent>
    )
  }

  return (
    <DialogContent
      className={cn(className)}
      data-slot="surface-content"
      showCloseButton={showCloseButton}
      {...props}
    >
      {keyedChildren}
    </DialogContent>
  )
}

function SurfaceHeader({ className, ...props }: React.ComponentProps<'div'>) {
  const { isMobile } = useSurfaceContext()
  const isAlert = useIsAlert()
  const Component = isMobile
    ? DrawerHeader
    : isAlert
      ? AlertDialogHeader
      : DialogHeader

  return (
    <Component data-slot="surface-header" className={className} {...props} />
  )
}

function SurfaceTitle({ children, ...props }: SurfaceTextProps) {
  const { isMobile } = useSurfaceContext()
  const isAlert = useIsAlert()
  const Component = isMobile
    ? DrawerTitle
    : isAlert
      ? AlertDialogTitle
      : DialogTitle

  return (
    <Component data-slot="surface-title" {...props}>
      {children}
    </Component>
  )
}

function SurfaceDescription({ children, ...props }: SurfaceTextProps) {
  const { isMobile } = useSurfaceContext()
  const isAlert = useIsAlert()
  const Component = isMobile
    ? DrawerDescription
    : isAlert
      ? AlertDialogDescription
      : DialogDescription

  return (
    <Component data-slot="surface-description" {...props}>
      {children}
    </Component>
  )
}

/** Icon/media container for alert-style surfaces.
 *  On desktop alert variant, renders AlertDialogMedia.
 *  Otherwise renders a styled div with the same layout. */
function SurfaceMedia({
  className,
  children,
  ...props
}: React.ComponentProps<'div'>) {
  const isAlert = useIsAlert()

  if (isAlert) {
    return (
      <AlertDialogMedia className={className} {...props}>
        {children}
      </AlertDialogMedia>
    )
  }

  return (
    <div
      data-slot="surface-media"
      className={cn(
        'mb-2 inline-flex size-10 items-center justify-center rounded-md',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  )
}

function SurfaceBody({
  children,
  className,
}: {
  children?: React.ReactNode
  className?: string
}) {
  return (
    <ScrollArea
      className={cn('flex-1 overflow-y-auto', className)}
      data-slot="surface-body"
    >
      {children}
    </ScrollArea>
  )
}

function SurfaceFooter({
  className,
  children,
  ...props
}: React.ComponentProps<'div'>) {
  const { isMobile } = useSurfaceContext()
  const isAlert = useIsAlert()

  if (isAlert) {
    return (
      <AlertDialogFooter
        data-slot="surface-footer"
        className={className}
        {...props}
      >
        {children}
      </AlertDialogFooter>
    )
  }

  return (
    <div
      data-slot="surface-footer"
      className={cn(
        isMobile
          ? 'shrink-0 border-t bg-background/95 py-2 backdrop-blur supports-backdrop-filter:bg-background/60'
          : 'mt-5 flex justify-end gap-2',
        className,
      )}
      {...props}
    >
      <div
        className={
          isMobile ? 'flex w-full gap-2' : 'flex w-full justify-end gap-2'
        }
      >
        {children}
      </div>
    </div>
  )
}

function SurfaceCancelButton({
  onClick,
  children = 'Cancel',
  ...props
}: React.ComponentProps<typeof Button>) {
  const { isMobile, surface } = useSurfaceContext()
  const isAlert = useIsAlert()
  const closeSurface = useSurface((s) => s.closeSurface)

  return (
    <Button
      className={cn(isMobile && 'flex-1')}
      variant={isMobile || isAlert ? 'outline' : 'ghost'}
      onClick={(e) => {
        closeSurface(surface)
        onClick?.(e)
      }}
      {...props}
    >
      {children}
    </Button>
  )
}

function SurfaceActionButton({
  onClick,
  ...props
}: React.ComponentProps<typeof Button>) {
  const { isMobile, surface, closeOnAction } = useSurfaceContext()
  const closeSurface = useSurface((s) => s.closeSurface)

  return (
    <Button
      className={cn(isMobile && 'flex-1')}
      onClick={(e) => {
        onClick?.(e)
        if (closeOnAction) closeSurface(surface)
      }}
      {...props}
    />
  )
}

export {
  SurfaceActionButton,
  SurfaceBody,
  SurfaceCancelButton,
  SurfaceContainer,
  SurfaceContent,
  SurfaceDescription,
  SurfaceFooter,
  SurfaceHeader,
  SurfaceMedia,
  SurfaceTitle,
  SurfaceTrigger,
}
`;
}

// ---------------------------------------------------------------------------
// Surfaces: surface-definitions.gen.ts (empty initial barrel)
// ---------------------------------------------------------------------------

export function generateSurfaceDefinitionsGenContent(): string {
  return `// AUTO-GENERATED by surfaces-codegen — DO NOT EDIT
// No surfaces found. Create a *.surface.tsx file to get started.

export const Surface = {} as const
`;
}

// ---------------------------------------------------------------------------
// Surfaces: index.ts (re-exports)
// ---------------------------------------------------------------------------

export function generateSurfaceIndexContent(): string {
  return `export { defineSurface } from './define-surface'
export type { SurfaceHandle } from './define-surface'

export { Surface } from './surface-definitions.gen'

export { useSurface } from './surface.registry'

export {
  SurfaceActionButton,
  SurfaceBody,
  SurfaceCancelButton,
  SurfaceContainer,
  SurfaceContent,
  SurfaceDescription,
  SurfaceFooter,
  SurfaceHeader,
  SurfaceTitle,
  SurfaceTrigger,
} from './surface'
`;
}

// ---------------------------------------------------------------------------
// Sidepanels: define-panel.ts
// ---------------------------------------------------------------------------

export function generateDefinePanelContent(): string {
  return `import type React from 'react'
import type { z } from 'zod'

/** Runtime config shape — uses wide generics since any panel can be stored */
type StoredPanelConfig = PanelConfig<
  z.ZodType | undefined,
  ReadonlyArray<string>
>

// Runtime store — populated by definePanel() calls at module import time
const _panels = new Map<string, StoredPanelConfig>()

export interface PanelConfig<
  TSchema extends z.ZodType | undefined = undefined,
  TRouteParams extends ReadonlyArray<string> = readonly [],
> {
  component: React.ComponentType<any>
  contextParams?: TSchema
  routeParams?: TRouteParams
}

export interface PanelHandle<
  TSchema extends z.ZodType | undefined = undefined,
  TRouteParams extends ReadonlyArray<string> = readonly [],
> {
  readonly id: string
  readonly component: React.ComponentType<any>
  readonly contextParams?: TSchema
  readonly routeParams?: TRouteParams
}

/**
 * Register a panel and return a typed handle.
 *
 * @example
 * export const ManageRole = definePanel('manage-role', {
 *   component: ManageRolePanel,
 *   contextParams: z.object({ roleId: z.string() }),
 *   routeParams: ['campusId'],
 * })
 */
export function definePanel<
  const TSchema extends z.ZodType | undefined = undefined,
  const TRouteParams extends ReadonlyArray<string> = readonly [],
>(
  id: string,
  config: PanelConfig<TSchema, TRouteParams>,
): PanelHandle<TSchema, TRouteParams> {
  _panels.set(id, config as StoredPanelConfig)
  return { id, ...config }
}

/** Runtime lookup used by the Zustand store and container */
export function getPanelConfig(id: string): StoredPanelConfig | undefined {
  return _panels.get(id)
}
`;
}

// ---------------------------------------------------------------------------
// Sidepanels: types.ts
// ---------------------------------------------------------------------------

export function generatePanelTypesContent(): string {
  return `import type { z } from 'zod'

/** Route params that must exist in the URL for the panel to render */
export type RouteParamRequirement<
  TParams extends ReadonlyArray<string> = ReadonlyArray<string>,
> = TParams

/** Missing context reported when validation fails */
export type MissingContext = {
  /** Route params missing from the current URL */
  missingRouteParams?: Array<string>
  /** Zod validation issues for context params */
  contextIssues?: Array<z.core.$ZodIssue>
}
`;
}

// ---------------------------------------------------------------------------
// Sidepanels: use-sidepanel.ts
// ---------------------------------------------------------------------------

export function generateUseSidepanelContent(): string {
  return `import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { getPanelConfig } from './define-panel'
import type { PanelHandle } from './define-panel'
import type { MissingContext } from './types'
import type { z } from 'zod'

// ~ =============================================>
// ~ ======= Types
// ~ =============================================>
type PanelSize = 'smallest' | 'small' | 'normal' | 'wide' | 'widest'

const PANEL_SIZES: Record<
  PanelSize,
  { main: number; side: number; minWidth: number }
> = {
  smallest: { main: 80, side: 20, minWidth: 240 },
  small: { main: 75, side: 25, minWidth: 280 },
  normal: { main: 70, side: 30, minWidth: 320 },
  wide: { main: 65, side: 35, minWidth: 360 },
  widest: { main: 60, side: 40, minWidth: 400 },
}

type CurrentPanel = {
  name: string
  props: any
}

// ~ =============================================>
// ~ ======= State
// ~ =============================================>
type SidepanelState = {
  isOpen: boolean
  panelSize: PanelSize
  currentPanel: CurrentPanel | null
  currentPanelProps: any
  overlay: boolean
  contextValid: boolean
  missingContext: MissingContext
  openPanel: <
    TSchema extends z.ZodType | undefined = undefined,
    TRouteParams extends ReadonlyArray<string> = readonly [],
  >(
    panel: PanelHandle<TSchema, TRouteParams>,
    options: { size: PanelSize; overlay?: boolean },
    ...params: TSchema extends z.ZodType
      ? [z.input<TSchema>]
      : [Record<string, unknown>?]
  ) => void
  closePanel: () => void
  togglePanel: () => void
  toggleOverlay: () => void
  setPanelSize: (size: PanelSize) => void
}

// ~ =============================================>
// ~ ======= Helper Functions
// ~ =============================================>
let currentRouteParams: Record<string, string | undefined> = {}

const updateRouteParams = (params: Record<string, string | undefined>) => {
  currentRouteParams = params
}

const getCurrentRouteParams = () => currentRouteParams

// ~ =============================================>
// ~ ======= Store
// ~ =============================================>
const useSidePanel = create<SidepanelState>()(
  persist(
    (set, get) => ({
      isOpen: false,
      panelSize: 'normal',
      overlay: false,
      currentPanel: null,
      currentPanelProps: null,
      contextValid: true,
      missingContext: {},

      togglePanel: () => {
        const { isOpen, currentPanel } = get()
        // No-op if there's no panel to show
        if (!currentPanel) return
        set({ isOpen: !isOpen })
      },
      toggleOverlay: () => set((state) => ({ overlay: !state.overlay })),
      setPanelSize: (size) => set({ panelSize: size }),

      openPanel: (panel, options, ...props) => {
        const contextProps = (props[0] ?? {}) as Record<string, unknown>
        const routeParams = getCurrentRouteParams()
        const { isValid, missingContext } = validatePanelContext(
          panel.id,
          contextProps,
          routeParams,
        )

        set({
          isOpen: true,
          panelSize: options.size,
          overlay: options.overlay ?? false,
          currentPanel: { name: panel.id, props: contextProps },
          currentPanelProps: contextProps,
          contextValid: isValid,
          missingContext,
        })
      },

      closePanel: () =>
        set({
          isOpen: false,
          currentPanel: null,
          currentPanelProps: null,
          overlay: false,
          contextValid: true,
          missingContext: {},
        }),
    }),
    {
      name: 'sidepanel-state',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        isOpen: state.isOpen,
        panelSize: state.panelSize,
        currentPanel: state.currentPanel,
        currentPanelProps: state.currentPanelProps,
        overlay: state.overlay,
      }),
    },
  ),
)

// ~ =============================================>
// ~ ======= Helper: Validate Panel Context
// ~ =============================================>
const validatePanelContext = (
  panelId: string,
  contextProps: Record<string, unknown>,
  routeParams: Record<string, string | undefined>,
): {
  isValid: boolean
  missingContext: MissingContext
} => {
  const config = getPanelConfig(panelId)
  if (!config) return { isValid: true, missingContext: {} }

  const missingContext: MissingContext = {}

  // 1. Validate route params
  if (config.routeParams?.length) {
    const missing = config.routeParams.filter((p: string) => !routeParams[p])
    if (missing.length > 0) missingContext.missingRouteParams = missing
  }

  // 2. Validate context params via Zod
  if (config.contextParams) {
    const schema = config.contextParams as z.ZodType
    const result = schema.safeParse(contextProps)
    if (!result.success) missingContext.contextIssues = result.error.issues
  }

  const isValid =
    !missingContext.missingRouteParams && !missingContext.contextIssues

  return { isValid, missingContext }
}

// ~ =============================================>
// ~ ======= Typed Panel Params Hook
// ~ =============================================>
/**
 * Read the current panel's context params with full type safety.
 *
 * @example
 * // In staff-department.panel.tsx
 * const { departmentId } = usePanelParams(StaffDepartment)
 */
function usePanelParams<TSchema extends z.ZodType>(
  panel: PanelHandle<TSchema>,
): z.output<TSchema> {
  const props = useSidePanel((s) => s.currentPanelProps)
  return panel.contextParams!.parse(props)
}

export {
  PANEL_SIZES,
  updateRouteParams,
  usePanelParams,
  useSidePanel,
  validatePanelContext,
}
export type { MissingContext, PanelSize, SidepanelState }
`;
}

// ---------------------------------------------------------------------------
// Sidepanels: sidepanel.container.tsx
// ---------------------------------------------------------------------------

export function generateSidepanelContainerContent(
  importPrefix: string,
): string {
  return `import { Cancel01Icon, DropletIcon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useParams } from '@tanstack/react-router'
import React from 'react'
import { Button } from '${importPrefix}components/ui/button'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '${importPrefix}components/ui/empty'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '${importPrefix}components/ui/select'
import { getPanelConfig } from './define-panel'
// Side-effect import: ensures all panel modules are loaded and registered
// in the runtime Map via definePanel(), even if no consumer imports \`Panel\`.
import './panel-definitions.gen'
import {
  updateRouteParams,
  useSidePanel,
  validatePanelContext,
} from './use-sidepanel'
import type { PanelSize } from './use-sidepanel'
import { cn } from '${importPrefix}lib/utils'

// ~ =============================================>
// ~ ======= Container Component
// ~ =============================================>
const SidePanelContainer = () => {
  const sidepanelState = useSidePanel()
  const params = useParams({ strict: false })

  // Update global route params whenever they change
  React.useEffect(() => {
    updateRouteParams(params)
  }, [params])

  // Re-validate context when route changes and panel is open
  React.useEffect(() => {
    if (!(sidepanelState.isOpen && sidepanelState.currentPanel)) return

    const { isValid, missingContext } = validatePanelContext(
      sidepanelState.currentPanel.name,
      sidepanelState.currentPanel.props ?? {},
      params,
    )

    const hasChanged =
      isValid !== sidepanelState.contextValid ||
      JSON.stringify(missingContext) !==
        JSON.stringify(sidepanelState.missingContext)

    if (hasChanged) {
      useSidePanel.setState({ contextValid: isValid, missingContext })
    }
  }, [params, sidepanelState.isOpen, sidepanelState.currentPanel])

  if (!sidepanelState.currentPanel) {
    return (
      <div className="flex h-full w-full flex-col overflow-hidden">
        <div className="flex h-14 w-full items-center border-b px-3">
          <Button
            onClick={() => sidepanelState.closePanel()}
            size="icon"
            variant="ghost"
          >
            <HugeiconsIcon icon={Cancel01Icon} />
          </Button>
          <Select
            aria-label="Select panel size"
            onValueChange={(value) =>
              value && sidepanelState.setPanelSize(value as PanelSize)
            }
            value={sidepanelState.panelSize}
          >
            <SelectTrigger className="w-full" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="smallest">Smallest</SelectItem>
              <SelectItem value="small">Small</SelectItem>
              <SelectItem value="normal">Normal</SelectItem>
              <SelectItem value="wide">Wide</SelectItem>
              <SelectItem value="widest">Widest</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex w-full flex-1 items-center justify-center overflow-auto p-4">
          <span className="wrap-break-words text-center text-muted-foreground text-sm">
            No panel selected
          </span>
        </div>
      </div>
    )
  }

  if (!sidepanelState.contextValid) {
    return (
      <div className="flex h-full w-full flex-col overflow-hidden">
        <div className="flex h-14 w-full items-center border-b px-3">
          <Button
            onClick={() => sidepanelState.closePanel()}
            size="icon"
            variant="ghost"
          >
            <HugeiconsIcon icon={Cancel01Icon} />
          </Button>
        </div>
        <Empty className="flex-1 border-0">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HugeiconsIcon icon={DropletIcon} />
            </EmptyMedia>
            <EmptyTitle>Content not available here</EmptyTitle>
            <EmptyDescription>
              This panel isn't available on the current page. Navigate back or
              close this panel.
            </EmptyDescription>
          </EmptyHeader>

          <EmptyContent>
            <Button onClick={sidepanelState.closePanel} variant="outline">
              Close Panel
            </Button>
          </EmptyContent>
        </Empty>
      </div>
    )
  }

  const panelConfig = getPanelConfig(sidepanelState.currentPanel.name)
  const PanelComponent = panelConfig?.component

  if (!PanelComponent) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <p className="text-destructive text-sm">Panel not found</p>
      </div>
    )
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <PanelComponent {...(sidepanelState.currentPanel.props || {})} />
    </div>
  )
}

// ~ =============================================>
// ~ ======= SidePanelNavBar
// ~ =============================================>
const SidePanelNavBar = ({
  children,
  className,
  showCloseButton = true,
}: {
  children: React.ReactNode
  className?: string
  showCloseButton?: boolean
}) => {
  const { closePanel } = useSidePanel()
  return (
    <div
      className={cn(
        'flex h-14 w-full items-center justify-between border-b px-3',
        className,
      )}
    >
      {children}
      {showCloseButton && (
        <Button onClick={closePanel} size="icon" variant="ghost">
          <HugeiconsIcon icon={Cancel01Icon} />
        </Button>
      )}
    </div>
  )
}

// ~ =============================================>
// ~ ======= SidePanelBody
// ~ =============================================>
const SidePanelBody = ({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) => (
  <div className={cn('h-full w-full flex-1 overflow-hidden p-4', className)}>
    {children}
  </div>
)

export default SidePanelContainer
export { SidePanelBody, SidePanelNavBar }
`;
}

// ---------------------------------------------------------------------------
// Sidepanels: sidepanel.layout.tsx
// ---------------------------------------------------------------------------

export function generateSidepanelLayoutContent(importPrefix: string): string {
  return `import React from 'react'
import SidePanelContainer from './sidepanel.container'
import { PANEL_SIZES, useSidePanel } from './use-sidepanel'
import { cn } from '${importPrefix}lib/utils'
import { useIsMobile } from '${importPrefix}hooks/use-mobile'

const SidePanelLayout = ({ children }: { children: React.ReactNode }) => {
  const { isOpen: sidePanelOpen, panelSize, overlay } = useSidePanel()
  const sizeConfig = PANEL_SIZES[panelSize]
  const isMobile = useIsMobile()

  if (isMobile) {
    return (
      <div className="relative h-full w-full">
        <div className="h-(--panel-body-height) w-full overflow-hidden">
          {children}
        </div>

        <div
          className={cn(
            'absolute inset-0 z-50 bg-background transition-transform duration-300 ease-in-out',
            sidePanelOpen ? 'translate-x-0' : 'translate-x-full',
          )}
        >
          <SidePanelContainer />
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full w-full flex-row">
      <div
        className={cn(
          'h-(--panel-body-height) relative overflow-hidden transition-all duration-300 ease-in-out',
          overlay && 'pointer-events-none select-none',
        )}
        style={{
          width: sidePanelOpen ? \`\${sizeConfig.main}%\` : '100%',
        }}
      >
        {children}
        <div
          className={\`absolute top-0 left-0 z-50 h-full w-full bg-background/30 backdrop-blur-sm transition-transform duration-300 ease-in-out \${
            overlay ? 'translate-x-0' : 'translate-x-full'
          }\`}
          style={{
            pointerEvents: overlay ? 'auto' : 'none',
          }}
        />
      </div>

      <div
        className={\`h-(--panel-body-height) overflow-hidden transition-all duration-300 ease-in-out \${
          sidePanelOpen ? 'opacity-100' : 'opacity-0'
        }\`}
        style={{
          width: sidePanelOpen ? \`\${sizeConfig.side}%\` : '0',
          minWidth: sidePanelOpen ? sizeConfig.minWidth : 0,
        }}
      >
        <div className="h-full w-full border-l">
          <SidePanelContainer />
        </div>
      </div>
    </div>
  )
}

export { SidePanelLayout }
`;
}

// ---------------------------------------------------------------------------
// Sidepanels: panel-definitions.gen.ts (empty initial barrel)
// ---------------------------------------------------------------------------

export function generatePanelDefinitionsGenContent(): string {
  return `// AUTO-GENERATED by sidepanels-codegen — DO NOT EDIT
// No panels found. Create a *.panel.tsx file to get started.

export const Panel = {} as const
`;
}

// ---------------------------------------------------------------------------
// Sidepanels: index.ts (re-exports)
// ---------------------------------------------------------------------------

export function generatePanelIndexContent(): string {
  return `export { Panel } from './panel-definitions.gen'
export { definePanel } from './define-panel'
export type { PanelHandle } from './define-panel'
export { SidePanelBody, SidePanelNavBar } from './sidepanel.container'
export { default as SidePanelContainer } from './sidepanel.container'
export { SidePanelLayout } from './sidepanel.layout'
export { usePanelParams, useSidePanel, PANEL_SIZES } from './use-sidepanel'
export type { MissingContext, PanelSize, SidepanelState } from './use-sidepanel'
`;
}
