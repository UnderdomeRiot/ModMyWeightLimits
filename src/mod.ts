import { DependencyContainer } from "tsyringe";
import { IPreSptLoadMod } from "@spt/models/external/IPreSptLoadMod";
import { IPostDBLoadMod } from "@spt/models/external/IPostDBLoadMod";

import { DatabaseServer } from "@spt/servers/DatabaseServer";
import { LogTextColor } from "@spt/models/spt/logging/LogTextColor";
import { ProfileHelper } from "@spt/helpers/ProfileHelper";
import { SkillTypes } from "@spt/models/enums/SkillTypes";

import type { ILogger } from "@spt/models/spt/utils/ILogger";
import type { StaticRouterModService } from "@spt/services/mod/staticRouter/StaticRouterModService";

class Mod implements IPreSptLoadMod, IPostDBLoadMod 
{

    private readonly modName = "ModMyWeight";

    private container: DependencyContainer;
    private config = require("../config/config.json");
    private logger: ILogger;

    private pmcLevel: number = 0;
    private strengthLevel: number = 0;
    private tables: any;
    private stamina: any;
    private execute: boolean = false;

    public preSptLoad(container: DependencyContainer): void 
    {
        this.container = container;
        const staticRouterModService = container.resolve<StaticRouterModService>("StaticRouterModService");

        staticRouterModService.registerStaticRouter(
            "ModMyWeight_/client/game/start",
            [
                {
                    url: "/client/game/start",
                    action: this.handleGameStart.bind(this)
                }
            ],
            this.modName
        );
    }

    public postDBLoad(container: DependencyContainer): void 
    {
        this.container = container;
        this.logger = container.resolve<ILogger>("WinstonLogger");
        this.logger.log(`[${this.modName}] : Mod loading`, LogTextColor.WHITE);

        this.tables = container.resolve<DatabaseServer>("DatabaseServer").getTables();
        this.stamina = this.tables.globals.config.Stamina;

        this.initializeConfig();
    }

    private handleGameStart(url: string, info: any, sessionId: string, output: any): any 
    {
        const profileHelper = this.container.resolve<ProfileHelper>("ProfileHelper");
        const profile = profileHelper.getPmcProfile(sessionId);

        this.pmcLevel = profile.Info.Level;
        this.strengthLevel = profileHelper.getSkillFromProfile(profile, SkillTypes.STRENGTH)?.Progress || 0;

        if (this.execute) 
        {
            this.applyWeightModifications();
        }

        return output;
    }

    private initializeConfig(): void 
    {
        const activeOptions = [
            this.config.FIRST_OPTION,
            this.config.SECOND_OPTION,
            this.config.THIRD_OPTION,
            this.config.FOURTH_OPTION
        ].filter(Boolean);

        if (activeOptions.length !== 1) 
        {
            const errorMessage =
                activeOptions.length === 0
                    ? "At least one option"
                    : "Only one option";
            this.logger.log(`[${this.modName}] : ${errorMessage} of [${this.modName}] must be true, mod deactivated`, LogTextColor.RED);
            return;
        }

        this.execute = true;

        if (this.config.FIRST_OPTION) 
        {
            this.logger.log(`[${this.modName}] : Applying [option 1] waiting game to start...`, LogTextColor.GREEN);
        }
        else if (this.config.SECOND_OPTION) 
        {
            this.logger.log(`[${this.modName}] : Applying [option 2] waiting game to start...`, LogTextColor.GREEN);
        }
        else if (this.config.THIRD_OPTION) 
        {
            this.applyFixedMultiplier(this.config.multiplier);
            this.logger.log(`[${this.modName}] : Applied [option 3] default static multiplier ${this.config.multiplier}x`, LogTextColor.GREEN);
        } 
        else if (this.config.FOURTH_OPTION) 
        {
            this.applyCustomWeightLimits(this.config);
            this.logger.log(`[${this.modName}] : Applied [option 4] custom weight limits`, LogTextColor.GREEN);
        }
    }

    private applyWeightModifications(): void 
    {
        if (this.config.FIRST_OPTION) 
        {
            this.modifyWeightBasedOnStrength();
        } 
        else if (this.config.SECOND_OPTION) 
        {
            this.modifyWeightBasedOnLevel();
        }
    }

    private modifyWeightBasedOnStrength(): void 
    {
        if (!this.strengthLevel) 
        {
            this.logger.log(`[${this.modName}] : Strength level not initialized`, LogTextColor.RED);
            return;
        }

        const multiplier = 1 + (this.strengthLevel / 10000) * this.config.multiplierPerStrengthLevel;
        this.applyFixedMultiplier(multiplier);
        this.logger.log(`[${this.modName}] : Applied [option 1] weight modifications based on strength level, multiplier of ${multiplier}x`, LogTextColor.GREEN);
    }

    private modifyWeightBasedOnLevel(): void 
    {
        if (!this.pmcLevel) 
        {
            this.logger.log(`[${this.modName}] : PMC level not initialized`, LogTextColor.RED);
            return;
        }

        const multiplier = 1 + (this.pmcLevel / 100) * this.config.multiplierPerPMCLevel;
        this.applyFixedMultiplier(multiplier);
        this.logger.log(`[${this.modName}] : Applied [option 2] weight modifications based on PMC level, multiplier of ${multiplier}x`, LogTextColor.GREEN);
    }

    private applyFixedMultiplier(multiplier: number): void 
    {
        [
            "SprintOverweightLimits",
            "WalkOverweightLimits",
            "WalkSpeedOverweightLimits",
            "BaseOverweightLimits"
        ].forEach((limit) => 
        {
            this.stamina[limit].x *= multiplier;
            this.stamina[limit].y *= multiplier;
        });
    }

    private applyCustomWeightLimits(limits: any): void 
    {
        [
            ["SprintOverweightLimits", "sprintOverweightLowerLimits", "sprintOverweightUpperLimits"],
            ["WalkOverweightLimits", "walkOverweightLowerLimits", "walkOverweightUpperLimits"],
            ["WalkSpeedOverweightLimits", "walkSpeedOverweightLowerLimits", "walkSpeedOverweightUpperLimits"],
            ["BaseOverweightLimits", "baseOverweightLowerLimits", "baseOverweightUpperLimits"]
        ].forEach(([key, lower, upper]) => 
        {
            this.stamina[key].x = limits[lower];
            this.stamina[key].y = limits[upper];
        });
    }
}

module.exports = { mod: new Mod() };
