import { NavLink, Outlet } from "react-router-dom"
import { cn } from "@/lib/utils"
import { NAV_ITEMS } from "./nav-config"
import { RaceCountdown } from "./RaceCountdown"
import { useOnboardingGate } from "@/hooks/useOnboardingGate"

function Wordmark() {
  return (
    <div>
      <h1 className="font-mono text-xl font-bold tracking-tight">
        HAL<span className="text-primary">E</span>
      </h1>
      <p className="text-muted-foreground -mt-0.5 text-[11px] tracking-wide italic">
        HALE's Adaptive Life Engine
      </p>
    </div>
  )
}

function SidebarNavLink({ item }: { item: (typeof NAV_ITEMS)[number] }) {
  return (
    <NavLink
      to={item.path}
      end={item.path === "/"}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
          isActive
            ? "bg-secondary text-foreground"
            : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
        )
      }
    >
      <item.icon className="size-4 shrink-0" strokeWidth={1.75} />
      {item.label}
    </NavLink>
  )
}

function BottomNavLink({ item }: { item: (typeof NAV_ITEMS)[number] }) {
  return (
    <NavLink
      to={item.path}
      end={item.path === "/"}
      className={({ isActive }) =>
        cn(
          "flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] font-medium transition-colors",
          isActive ? "text-primary" : "text-muted-foreground",
        )
      }
    >
      <item.icon className="size-5" strokeWidth={1.75} />
      {item.label}
    </NavLink>
  )
}

export function Shell() {
  useOnboardingGate()
  return (
    <div className="flex h-svh overflow-hidden">
      {/* Desktop sidebar — persistent, >=900px, pinned (doesn't scroll with content) */}
      <aside className="border-border hidden w-56 shrink-0 flex-col gap-6 overflow-y-auto border-r p-4 min-[900px]:flex">
        <Wordmark />
        <nav className="flex flex-col gap-1">
          {NAV_ITEMS.map((item) => (
            <SidebarNavLink key={item.path} item={item} />
          ))}
        </nav>
        <div className="mt-auto">
          <RaceCountdown />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Mobile header — <900px */}
        <header className="border-border flex items-center justify-between border-b p-4 min-[900px]:hidden">
          <Wordmark />
          <RaceCountdown />
        </header>

        <main className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden p-4 pb-20 min-[900px]:pb-4">
          <Outlet />
        </main>

        {/* Mobile bottom tab bar — <900px */}
        <nav className="border-border bg-background fixed inset-x-0 bottom-0 flex border-t min-[900px]:hidden">
          {NAV_ITEMS.map((item) => (
            <BottomNavLink key={item.path} item={item} />
          ))}
        </nav>
      </div>
    </div>
  )
}
