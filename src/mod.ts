import { DependencyContainer } from "tsyringe";
import { IPreSptLoadMod, IPostDBLoadMod } from "@spt/models/external/mod-interfaces";
import { DatabaseServer } from "@spt/servers/DatabaseServer";
import { LogTextColor } from "@spt/models/spt/logging/LogTextColor";
import { ProfileHelper } from "@spt/helpers/ProfileHelper";
import { SkillTypes } from "@spt/models/enums/SkillTypes";
import { ILogger } from "@spt/models/spt/utils/ILogger";
import { StaticRouterModService } from "@spt/services/mod/staticRouter/StaticRouterModService";

// Enums para mejorar la legibilidad y mantenibilidad
enum WeightOption {
    STRENGTH_BASED = 'FIRST_OPTION',
    PMC_LEVEL_BASED = 'SECOND_OPTION',
    STATIC_MULTIPLIER = 'THIRD_OPTION',
    CUSTOM_LIMITS = 'FOURTH_OPTION'
}

interface WeightConfig {
    [WeightOption.STRENGTH_BASED]: boolean;
    [WeightOption.PMC_LEVEL_BASED]: boolean;
    [WeightOption.STATIC_MULTIPLIER]: boolean;
    [WeightOption.CUSTOM_LIMITS]: boolean;
    VERBOSE_MODE: boolean;
    multiplier: number;
    multiplierPerStrengthLevel: number;
    multiplierPerPMCLevel: number;
    sprintOverweightLowerLimits: number;
    sprintOverweightUpperLimits: number;
    walkOverweightLowerLimits: number;
    walkOverweightUpperLimits: number;
    walkSpeedOverweightLowerLimits: number;
    walkSpeedOverweightUpperLimits: number;
    baseOverweightLowerLimits: number;
    baseOverweightUpperLimits: number;
}

interface StaminaLimits {
    x: number;
    y: number;
}

interface ModState {
    execute: boolean;
    alreadyApplied: boolean;
    pmcLevel: number;
    strengthLevel: number;
    previousPmcLevel: number;
    previousStrengthLevel: number;
    previousStamina: Record<string, StaminaLimits> | null;
}

class WeightMod implements IPreSptLoadMod, IPostDBLoadMod {
    private static readonly MOD_NAME = "ModMyWeightLimits";
    private static readonly WEIGHT_LIMITS = [
        ["SprintOverweightLimits", "sprintOverweightLowerLimits", "sprintOverweightUpperLimits"],
        ["WalkOverweightLimits", "walkOverweightLowerLimits", "walkOverweightUpperLimits"],
        ["WalkSpeedOverweightLimits", "walkSpeedOverweightLowerLimits", "walkSpeedOverweightUpperLimits"],
        ["BaseOverweightLimits", "baseOverweightLowerLimits", "baseOverweightUpperLimits"]
    ] as const;

    private readonly config: WeightConfig;
    private readonly state: ModState;
    private container: DependencyContainer;
    private logger: ILogger;
    private tables: any;
    private stamina: Record<string, StaminaLimits>;

    constructor() {
        this.config = require("../config/config.json");
        this.state = {
            execute: false,
            alreadyApplied: false,
            pmcLevel: 0,
            strengthLevel: 0,
            previousPmcLevel: 0,
            previousStrengthLevel: 0,
            previousStamina: null
        };
    }

    private verboseLog(message: string, color: LogTextColor = LogTextColor.WHITE): void {
        if (this.config.VERBOSE_MODE) {
            this.logger.log(`[${WeightMod.MOD_NAME}] : ${message}`, color);
        }
    }

    private systemLog(message: string, color: LogTextColor = LogTextColor.WHITE): void {
        this.logger.log(`[${WeightMod.MOD_NAME}] : ${message}`, color);
    }

    public preSptLoad(container: DependencyContainer): void {
        this.container = container;
        this.registerRouter();
    }

    public postDBLoad(container: DependencyContainer): void {
        this.initializeServices(container);
        this.initializeConfig();
    }

    private registerRouter(): void {
        const staticRouterModService = this.container.resolve<StaticRouterModService>("StaticRouterModService");
        staticRouterModService.registerStaticRouter(
            `${WeightMod.MOD_NAME}_/client/game/start`,
            [{
                url: "/client/game/start",
                action: (_url: string, _info: any, sessionId: string, output: any) => 
                    this.handleGameStart(sessionId, output)
            }],
            WeightMod.MOD_NAME
        );
    }

    private initializeServices(container: DependencyContainer): void {
        this.container = container;
        this.logger = container.resolve<ILogger>("WinstonLogger");
        this.systemLog("Mod loading", LogTextColor.WHITE);

        const dbServer = container.resolve<DatabaseServer>("DatabaseServer");
        this.tables = dbServer.getTables();
        this.stamina = this.tables.globals.config.Stamina;
        this.state.previousStamina = { ...this.stamina };
    }

    private handleGameStart(sessionId: string, output: any): any {
        if (!this.state.execute) return output;

        const profile = this.container.resolve<ProfileHelper>("ProfileHelper")
            .getPmcProfile(sessionId);

        this.updateLevels(profile);
        this.checkLevelChanges();
        this.applyWeightModifications();

        return output;
    }

    private updateLevels(profile: any): void {
        const profileHelper = this.container.resolve<ProfileHelper>("ProfileHelper");
        this.state.pmcLevel = profile.Info.Level;
        this.state.strengthLevel = Math.floor(
            (profileHelper.getSkillFromProfile(profile, SkillTypes.STRENGTH)?.Progress || 0) / 100
        );
    }

    private checkLevelChanges(): void {
        const strengthLevelIncreased = this.state.strengthLevel > this.state.previousStrengthLevel;
        const pmcLevelIncreased = this.state.pmcLevel > this.state.previousPmcLevel;

        if (strengthLevelIncreased && this.config[WeightOption.STRENGTH_BASED]) {
            this.state.previousStrengthLevel = this.state.strengthLevel;
            this.state.alreadyApplied = false;
        } else if (pmcLevelIncreased && this.config[WeightOption.PMC_LEVEL_BASED]) {
            this.state.previousPmcLevel = this.state.pmcLevel;
            this.state.alreadyApplied = false;
        }
    }

    private initializeConfig(): void {
        const activeOptions = Object.values(WeightOption)
            .filter(option => this.config[option])
            .length;

        if (activeOptions !== 1) {
            this.systemLog(
                `${activeOptions === 0 ? 'At least' : 'Only'} one option must be true, mod deactivated`,
                LogTextColor.RED
            );
            return;
        }

        this.applySelectedOption();
    }

    private calculateMultiplier(level: number, multiplierPerLevel: number): number {
        const baseMultiplier = 1;
        const percentage = level / 100;
        const bonus = percentage * multiplierPerLevel;
        return baseMultiplier + bonus;
    }

    private logMultiplierCalculation(label: string, level: number, multiplierPerLevel: number, finalMultiplier: number): void {
        this.verboseLog(`Calculating ${label}-based multiplier:`, LogTextColor.GREEN);
        this.verboseLog(`→ Current ${label} level: ${level}`, LogTextColor.WHITE);
        this.verboseLog(`→ ${label} as percentage: ${(level / 100).toFixed(2)} (${level}/100)`, LogTextColor.WHITE);
        this.verboseLog(`→ ${label} bonus: ${((level / 100) * multiplierPerLevel).toFixed(2)} (${(level / 100).toFixed(2)} × ${multiplierPerLevel} multiplierPer${label}Level)`, LogTextColor.WHITE);
        this.verboseLog(`→ Final multiplier: ${finalMultiplier.toFixed(2)} (1 + ${((level / 100) * multiplierPerLevel).toFixed(2)})`, LogTextColor.WHITE);
    }

    private applySelectedOption(): void {
        const options: Record<WeightOption, () => void> = {
            [WeightOption.STRENGTH_BASED]: () => {
                this.state.execute = true;
                this.verboseLog("Applying [Strength-based / Option 1] waiting game to start...", LogTextColor.GREEN);
            },
            [WeightOption.PMC_LEVEL_BASED]: () => {
                this.state.execute = true;
                this.verboseLog("Applying [PMC Level-based / Option 2] waiting game to start...", LogTextColor.GREEN);
            },
            [WeightOption.STATIC_MULTIPLIER]: () => {
                this.applyFixedMultiplier(this.config.multiplier);
                this.verboseLog(`Applied [Static Multiplier / Option 3] default static multiplier ${this.config.multiplier}x`, LogTextColor.GREEN);
            },
            [WeightOption.CUSTOM_LIMITS]: () => {
                this.applyCustomWeightLimits();
                this.verboseLog("Applied [Custom Limits / Option 4] custom weight limits", LogTextColor.GREEN);
            }
        };

        const selectedOption = Object.entries(options)
            .find(([key]) => this.config[key as WeightOption]);

        if (selectedOption) {
            selectedOption[1]();
        }
    }

    private applyWeightModifications(): void {
        if (this.config[WeightOption.STRENGTH_BASED]) {
            this.modifyWeightBasedOnStrength();
        } else if (this.config[WeightOption.PMC_LEVEL_BASED]) {
            this.modifyWeightBasedOnLevel();
        }
    }

    private modifyWeightBasedOnStrength(): void {
        if (!this.state.strengthLevel) {
            this.verboseLog("Strength level not initialized", LogTextColor.RED);
            return;
        }

        const multiplier = this.calculateMultiplier(
            this.state.strengthLevel,
            this.config.multiplierPerStrengthLevel
        );

        this.applyFixedMultiplier(multiplier);
        this.logMultiplierCalculation("Strength", this.state.strengthLevel, this.config.multiplierPerStrengthLevel, multiplier);
        this.verboseLog(`Applied weight modifications - All weight limits multiplied by ${multiplier.toFixed(2)}x`, LogTextColor.GREEN);
    }

    private modifyWeightBasedOnLevel(): void {
        if (!this.state.pmcLevel) {
            this.verboseLog("PMC level not initialized", LogTextColor.RED);
            return;
        }

        const multiplier = this.calculateMultiplier(
            this.state.pmcLevel,
            this.config.multiplierPerPMCLevel
        );

        this.applyFixedMultiplier(multiplier);
        this.logMultiplierCalculation("PMC", this.state.pmcLevel, this.config.multiplierPerPMCLevel, multiplier);
        this.verboseLog(`Applied weight modifications - All weight limits multiplied by ${multiplier.toFixed(2)}x`, LogTextColor.GREEN);
    }

    private applyFixedMultiplier(multiplier: number): void {
        if (this.state.alreadyApplied) return;

        WeightMod.WEIGHT_LIMITS.forEach(([limit]) => {
            if (this.state.previousStamina?.[limit]) {
                this.stamina[limit].x = this.state.previousStamina[limit].x * multiplier;
                this.stamina[limit].y = this.state.previousStamina[limit].y * multiplier;
            }
        });

        this.state.alreadyApplied = true;
    }

    private applyCustomWeightLimits(): void {
        WeightMod.WEIGHT_LIMITS.forEach(([key, lower, upper]) => {
            if (this.stamina[key]) {
                this.stamina[key].x = this.config[lower as keyof WeightConfig] as number;
                this.stamina[key].y = this.config[upper as keyof WeightConfig] as number;
            }
        });
    }
}

module.exports = { mod: new WeightMod() };