import { Fragment } from "react";
import type { LucideIcon } from "lucide-react";
import {
  BookOpen,
  Brain,
  Cable,
  Inbox,
  MoreHorizontal,
  Network,
  Pizza,
  Puzzle,
  ScrollText,
  Settings,
  Workflow,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { AppView } from "../admin-visibility.js";
import { L } from "../lexicon.js";

interface AppNavigationProps {
  view: AppView;
  enableAutomations: boolean;
  enableMemories: boolean;
  onViewChange: (view: AppView) => void;
  /** Unread counts shown on a destination, e.g. Fleet results to review. */
  counts?: Partial<Record<AppView, number>>;
}

interface NavDestination {
  view: AppView;
  label: string;
  mobileLabel?: string;
  icon: LucideIcon;
}

const inboxDestination: NavDestination = {
  view: "inbox",
  label: L.inboxSection,
  icon: Inbox,
};

const automationsDestination: NavDestination = {
  view: "automations",
  label: L.automationsSection,
  icon: Workflow,
};

const memoriesDestination: NavDestination = {
  view: "memories",
  label: L.memoriesSection,
  icon: Brain,
};

const skillsDestination: NavDestination = {
  view: "skills",
  label: L.skillsSection,
  icon: BookOpen,
};

const mcpDestination: NavDestination = {
  view: "mcp",
  label: L.mcpSection,
  icon: Cable,
};

const pluginsDestination: NavDestination = {
  view: "plugins",
  label: L.pluginsSection,
  icon: Puzzle,
};

const fleetDestination: NavDestination = {
  view: "fleet",
  label: L.fleetSection,
  icon: Network,
};

const settingsDestination: NavDestination = {
  view: "settings",
  label: L.settingsSection,
  icon: Settings,
};

const logsDestination: NavDestination = {
  view: "logs",
  label: "Logs",
  icon: ScrollText,
};

const countLabel = (label: string, count: number) => (count > 0 ? `${label}, ${count} unread` : label);

const countText = (count: number) => (count > 99 ? "99+" : String(count));

function RailButton({
  destination,
  view,
  onViewChange,
  count = 0,
}: {
  destination: NavDestination;
  view: AppView;
  onViewChange: (view: AppView) => void;
  count?: number;
}) {
  const Icon = destination.icon;
  const active = view === destination.view;

  return (
    <button
      className={`iconrail-btn${active ? " active" : ""}`}
      title={countLabel(destination.label, count)}
      aria-label={countLabel(destination.label, count)}
      aria-current={active ? "page" : undefined}
      onClick={() => onViewChange(destination.view)}
    >
      <Icon size={20} />
      {count > 0 && (
        <span className="iconrail-count" aria-hidden="true">
          {countText(count)}
        </span>
      )}
    </button>
  );
}

function MobileNavButton({
  destination,
  view,
  onViewChange,
}: {
  destination: NavDestination;
  view: AppView;
  onViewChange: (view: AppView) => void;
}) {
  const Icon = destination.icon;
  const active = view === destination.view;

  return (
    <button
      className={`mobile-nav-btn${active ? " active" : ""}`}
      aria-label={destination.label}
      aria-current={active ? "page" : undefined}
      onClick={() => onViewChange(destination.view)}
    >
      <Icon size={20} />
      <span>{destination.mobileLabel ?? destination.label}</span>
    </button>
  );
}

export function AppNavigation({
  view,
  enableAutomations,
  enableMemories,
  onViewChange,
  counts = {},
}: AppNavigationProps) {
  const desktopDestinations = [
    inboxDestination,
    skillsDestination,
    mcpDestination,
    ...(enableMemories ? [memoriesDestination] : []),
    ...(enableAutomations ? [automationsDestination] : []),
    fleetDestination,
  ];
  const mobileDestinations = [
    inboxDestination,
    skillsDestination,
    mcpDestination,
  ];
  const mobileFeatureDestinations = [
    ...(enableMemories ? [memoriesDestination] : []),
    ...(enableAutomations ? [automationsDestination] : []),
    fleetDestination,
  ];
  const utilityDestinations = [
    pluginsDestination,
    logsDestination,
    settingsDestination,
  ];
  const moreDestinations = [...mobileFeatureDestinations, ...utilityDestinations];
  const moreActive = moreDestinations.some((destination) => destination.view === view);
  const moreCount = moreDestinations.reduce((sum, destination) => sum + (counts[destination.view] ?? 0), 0);

  return (
    <>
      <nav className="iconrail" aria-label="Primary navigation">
        <div className="iconrail-logo" role="img" aria-label="Pizza Bot" title="Pizza Bot">
          <Pizza size={24} strokeWidth={1.8} />
        </div>
        {desktopDestinations.map((destination) => (
          <RailButton
            key={destination.view}
            destination={destination}
            view={view}
            onViewChange={onViewChange}
            count={counts[destination.view]}
          />
        ))}
        <div className="iconrail-spacer" />
        {utilityDestinations.map((destination) => (
          <RailButton
            key={destination.view}
            destination={destination}
            view={view}
            onViewChange={onViewChange}
          />
        ))}
      </nav>

      <nav className="mobile-nav" aria-label="Primary navigation">
        {mobileDestinations.map((destination) => (
          <MobileNavButton
            key={destination.view}
            destination={destination}
            view={view}
            onViewChange={onViewChange}
          />
        ))}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className={`mobile-nav-btn${moreActive ? " active" : ""}`}
              aria-label={countLabel("More destinations", moreCount)}
              aria-current={moreActive ? "page" : undefined}
            >
              <MoreHorizontal size={20} />
              {moreCount > 0 && <span className="iconrail-count" aria-hidden="true">{countText(moreCount)}</span>}
              <span>More</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="mobile-nav-menu"
            side="top"
            align="end"
            sideOffset={8}
          >
            {moreDestinations.map((destination, index) => {
              const Icon = destination.icon;
              return (
                <Fragment key={destination.view}>
                  {index === mobileFeatureDestinations.length &&
                    mobileFeatureDestinations.length > 0 && <DropdownMenuSeparator />}
                  <DropdownMenuItem
                    className={`mobile-nav-menu-item${
                      view === destination.view ? " active" : ""
                    }`}
                    onSelect={() => onViewChange(destination.view)}
                  >
                    <Icon />
                    {destination.label}
                    {(counts[destination.view] ?? 0) > 0 && (
                      <span className="mobile-nav-menu-count">{countText(counts[destination.view]!)}</span>
                    )}
                  </DropdownMenuItem>
                </Fragment>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </nav>
    </>
  );
}
