import { useTranslation } from "react-i18next";
import { useAppStore } from "@geolibre/core";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@geolibre/ui";
import { ChevronDown } from "lucide-react";

/** Temporary viewing switch and editor-only bulk hover actions. */
export function LayerHoverControls() {
  const { t } = useTranslation();
  const enabled = useAppStore((s) => s.hoverTooltipsEnabled);
  const setEnabled = useAppStore((s) => s.setHoverTooltipsEnabled);
  const resetLayerHovers = useAppStore((s) => s.resetLayerHovers);
  const collaborationActive = useAppStore((s) => s.collaboration.isActive);

  return (
    <div className="flex items-center gap-1 border-b px-3 py-1 text-xs">
      <span className="me-auto text-muted-foreground">{t("layers.hoverTooltips")}</span>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs"
        aria-pressed={enabled}
        onClick={() => setEnabled(!enabled)}
      >
        {enabled ? t("layers.turnHoversOff") : t("layers.restoreHovers")}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label={t("layers.hoverOptions")}
          >
            <ChevronDown className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            disabled={collaborationActive}
            onSelect={() => resetLayerHovers("project")}
          >
            {t("layers.resetHoversToProject")}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={collaborationActive}
            onSelect={() => resetLayerHovers("clear")}
          >
            {t("layers.clearAllHovers")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
