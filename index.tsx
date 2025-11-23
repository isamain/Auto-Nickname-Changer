/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { Logger } from "@utils/Logger";
import { ModalCloseButton, ModalContent, ModalFooter, ModalHeader, ModalProps, ModalRoot, openModal } from "@utils/modal";
import definePlugin, { OptionType } from "@utils/types";
import type { Channel, User } from "@vencord/discord-types";
import { findByPropsLazy } from "@webpack";
import {
    Button,
    Forms,
    GuildMemberStore,
    GuildStore,
    Menu,
    PermissionsBits,
    PermissionStore,
    React,
    TextInput,
    Toasts,
    UserStore
} from "@webpack/common";

const logger = new Logger("AutoNicknameChanger");

// Interfaces
interface NicknameConfig {
    userId: string;
    nickname: string;
    guildId: string;
}

interface RateLimitInfo {
    lastChange: number;
    pending: boolean;
}

interface UserContextProps {
    channel: Channel;
    guildId?: string;
    user: User;
}

// Global state
const rateLimitMap = new Map<string, RateLimitInfo>();

// Settings
export const settings = definePluginSettings({
    configs: {
        type: OptionType.STRING,
        description: "Stored nickname configurations (JSON)",
        restartNeeded: false,
        hidden: true,
        default: "[]"
    },
    rateLimitDelay: {
        type: OptionType.NUMBER,
        description: "Minimum seconds between nickname changes per user (to avoid rate limits)",
        restartNeeded: false,
        default: 2,
        isValid: (value: number) => value >= 1 && value <= 60 || "Must be between 1 and 60 seconds"
    },
    enablePeriodicCheck: {
        type: OptionType.BOOLEAN,
        description: "Enable periodic nickname checking (backup mechanism)",
        restartNeeded: false,
        default: true
    },
    periodicCheckInterval: {
        type: OptionType.NUMBER,
        description: "Periodic check interval in seconds",
        restartNeeded: false,
        default: 2,
        isValid: (value: number) => value >= 0.5 && value <= 60 || "Must be between 0.5 and 60 seconds"
    }
});

// Safe module access
const Auth = findByPropsLazy("getToken");

function safeGetToken(): string | null {
    try {
        if (!Auth?.getToken || typeof Auth.getToken !== "function") {
            logger.debug("Auth.getToken not available");
            return null;
        }
        const token = Auth.getToken();
        return typeof token === "string" ? token : null;
    } catch (error) {
        logger.error("Error getting auth token:", error);
        return null;
    }
}

function safeGetGuild(guildId: string) {
    try {
        if (!GuildStore?.getGuild || typeof GuildStore.getGuild !== "function") {
            logger.debug("GuildStore.getGuild not available");
            return null;
        }
        return GuildStore.getGuild(guildId);
    } catch (error) {
        logger.error("Error getting guild:", error);
        return null;
    }
}

function safeGetUser(userId: string) {
    try {
        if (!UserStore?.getUser || typeof UserStore.getUser !== "function") {
            logger.debug("UserStore.getUser not available");
            return null;
        }
        return UserStore.getUser(userId);
    } catch (error) {
        logger.error("Error getting user:", error);
        return null;
    }
}

function safeGetNick(guildId: string, userId: string): string | null {
    try {
        if (!GuildMemberStore?.getNick || typeof GuildMemberStore.getNick !== "function") {
            logger.debug("GuildMemberStore.getNick not available");
            return null;
        }
        return GuildMemberStore.getNick(guildId, userId) ?? null;
    } catch (error) {
        logger.error("Error getting nickname:", error);
        return null;
    }
}

function safeCanManageNicknames(guild: any): boolean {
    try {
        if (!PermissionStore?.can || typeof PermissionStore.can !== "function") {
            logger.debug("PermissionStore.can not available");
            return false;
        }
        if (!PermissionsBits?.MANAGE_NICKNAMES) {
            logger.debug("MANAGE_NICKNAMES permission not available");
            return false;
        }
        return PermissionStore.can(PermissionsBits.MANAGE_NICKNAMES, guild);
    } catch (error) {
        logger.error("Error checking permissions:", error);
        return false;
    }
}

// Configuration management
function getConfigs(): NicknameConfig[] {
    try {
        const stored = settings.store.configs;
        if (!stored || typeof stored !== "string") {
            logger.debug("No stored configs or invalid format");
            return [];
        }

        const parsed = JSON.parse(stored);
        if (!Array.isArray(parsed)) {
            logger.warn("Parsed configs is not an array", { parsed });
            return [];
        }

        // Validate each config
        const validConfigs = parsed.filter(config => {
            if (!config || typeof config !== "object") {
                logger.warn("Invalid config object", { config });
                return false;
            }
            if (!config.userId || !config.guildId || !config.nickname ||
                typeof config.userId !== "string" || typeof config.guildId !== "string" || typeof config.nickname !== "string") {
                logger.warn("Invalid config properties", { config });
                return false;
            }
            return true;
        });

        if (validConfigs.length !== parsed.length) {
            logger.warn("Some configs were invalid and filtered out", {
                original: parsed.length,
                valid: validConfigs.length
            });
            // Save the cleaned configs
            saveConfigs(validConfigs);
        }

        return validConfigs;
    } catch (error) {
        logger.error("Error parsing configs:", error);
        return [];
    }
}

function saveConfigs(configs: NicknameConfig[]) {
    try {
        if (!Array.isArray(configs)) {
            logger.error("Attempted to save non-array configs", { configs });
            return;
        }

        // Validate configs before saving
        const validConfigs = configs.filter(config => {
            if (!config || typeof config !== "object") {
                logger.warn("Filtering out invalid config object", { config });
                return false;
            }
            if (!config.userId || !config.guildId || !config.nickname ||
                typeof config.userId !== "string" || typeof config.guildId !== "string" || typeof config.nickname !== "string") {
                logger.warn("Filtering out config with invalid properties", { config });
                return false;
            }
            return true;
        });

        settings.store.configs = JSON.stringify(validConfigs);
        logger.debug("Saved configs", { count: validConfigs.length });
    } catch (error) {
        logger.error("Error saving configs:", error);
    }
}

function getConfigKey(userId: string, guildId: string): string {
    return `${guildId}-${userId}`;
}

function findConfig(userId: string, guildId: string): NicknameConfig | undefined {
    return getConfigs().find(c => c.userId === userId && c.guildId === guildId);
}

// Rate limiting
function canRateLimit(userId: string, guildId: string): boolean {
    try {
        if (!userId || !guildId || typeof userId !== "string" || typeof guildId !== "string") {
            logger.warn("Invalid parameters for canRateLimit", { userId, guildId });
            return false;
        }

        const key = getConfigKey(userId, guildId);
        const info = rateLimitMap.get(key);
        if (!info) {
            logger.debug("No rate limit info for user", { userId, guildId });
            return true;
        }

        const now = Date.now();
        const minDelay = settings.store.rateLimitDelay * 1000;

        if (info.pending) {
            logger.debug("Rate limit pending for user", { userId, guildId });
            return false;
        }
        if (now - info.lastChange < minDelay) {
            logger.debug("Rate limit active for user", { userId, guildId, timeLeft: minDelay - (now - info.lastChange) });
            return false;
        }

        return true;
    } catch (error) {
        logger.error("Error checking rate limit:", error);
        return false;
    }
}

function updateRateLimit(userId: string, guildId: string) {
    try {
        if (!userId || !guildId || typeof userId !== "string" || typeof guildId !== "string") {
            logger.warn("Invalid parameters for updateRateLimit", { userId, guildId });
            return;
        }

        const key = getConfigKey(userId, guildId);
        rateLimitMap.set(key, {
            lastChange: Date.now(),
            pending: true
        });

        logger.debug("Updated rate limit for user", { userId, guildId });

        // Clear pending after a short delay
        setTimeout(() => {
            try {
                const info = rateLimitMap.get(key);
                if (info) {
                    info.pending = false;
                    logger.debug("Cleared pending rate limit for user", { userId, guildId });
                }
            } catch (error) {
                logger.error("Error clearing pending rate limit:", error);
            }
        }, 1000);
    } catch (error) {
        logger.error("Error updating rate limit:", error);
    }
}

// Core functionality
async function updateMemberNickname(guildId: string, userId: string, nickname: string): Promise<boolean> {
    try {
        // Validate inputs
        if (!guildId || !userId || !nickname || typeof guildId !== "string" || typeof userId !== "string" || typeof nickname !== "string") {
            logger.warn("Invalid parameters for updateMemberNickname", { guildId, userId, nickname });
            return false;
        }

        if (!canRateLimit(userId, guildId)) {
            logger.debug("Rate limit active for user", { userId, guildId });
            return false;
        }

        const token = safeGetToken();
        if (!token) {
            logger.warn("No auth token available");
            return false;
        }

        const guild = safeGetGuild(guildId);
        if (!guild) {
            logger.warn("Guild not found", { guildId });
            return false;
        }

        if (!safeCanManageNicknames(guild)) {
            logger.warn("No permission to manage nicknames", { guildId });
            return false;
        }

        updateRateLimit(userId, guildId);

        logger.debug("Attempting to update nickname", { guildId, userId, nickname });

        const response = await fetch(`/api/v9/guilds/${guildId}/members/${userId}`, {
            method: "PATCH",
            headers: {
                "Authorization": token,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ nick: nickname })
        });

        if (response.ok) {
            logger.info("Successfully updated nickname", { guildId, userId, nickname });
            return true;
        } else {
            try {
                const errorText = await response.text().catch(() => "Unknown error");
                const errorMsg = errorText && typeof errorText === "string" ? errorText.substring(0, 50) : "Unknown error";

                logger.warn("Failed to update nickname", {
                    guildId,
                    userId,
                    nickname,
                    status: response.status,
                    error: errorMsg
                });

                // Don't show toast for rate limit errors to avoid spam
                if (response.status === 429) {
                    return false;
                }

                Toasts.show({
                    message: `Failed to change nickname (${response.status})`,
                    id: Toasts.genId(),
                    type: Toasts.Type.FAILURE
                });
            } catch (error) {
                logger.error("Error parsing response:", error);
            }
            return false;
        }
    } catch (error) {
        logger.error("Error updating nickname:", error);
        return false;
    }
}

function checkAndEnforceNickname(userId: string, guildId: string, targetNickname: string) {
    try {
        logger.info("checkAndEnforceNickname called", { userId, guildId, targetNickname });

        if (!userId || !guildId || !targetNickname || typeof userId !== "string" || typeof guildId !== "string" || typeof targetNickname !== "string") {
            logger.warn("Invalid parameters for checkAndEnforceNickname", { userId, guildId, targetNickname });
            return;
        }

        const currentNick = safeGetNick(guildId, userId);
        logger.info("Current nickname retrieved", { userId, guildId, currentNick, targetNickname });

        // Check if nickname needs to be changed
        if (currentNick !== targetNickname) {
            logger.info("Nickname mismatch detected - enforcing change", { userId, guildId, currentNick, targetNickname });
            void updateMemberNickname(guildId, userId, targetNickname).then(success => {
                if (success) {
                    logger.info("Nickname successfully enforced", { userId, guildId, targetNickname });
                } else {
                    logger.warn("Failed to enforce nickname", { userId, guildId, targetNickname });
                }
            }).catch(error => {
                logger.error("Error in async nickname update:", error);
            });
        } else {
            logger.debug("Nickname is already correct, no action needed", { userId, guildId, currentNick });
        }
    } catch (error) {
        logger.error("Error checking nickname:", error);
    }
}

function addConfig(userId: string, guildId: string, nickname: string) {
    try {
        if (!userId || !guildId || !nickname || typeof userId !== "string" || typeof guildId !== "string" || typeof nickname !== "string") {
            logger.warn("Invalid parameters for addConfig", { userId, guildId, nickname });
            return;
        }

        const configs = getConfigs();
        if (!Array.isArray(configs)) {
            logger.error("Invalid configs format");
            return;
        }

        const existingIndex = configs.findIndex(c => c && c.userId === userId && c.guildId === guildId);

        if (existingIndex >= 0) {
            configs[existingIndex].nickname = nickname;
        } else {
            configs.push({ userId, guildId, nickname });
        }

        saveConfigs(configs);
        // Check immediately if nickname needs to be changed
        setTimeout(() => {
            try {
                checkAndEnforceNickname(userId, guildId, nickname);
            } catch (error) {
                logger.error("Error in immediate nickname check:", error);
            }
        }, 1000); // Wait 1 second then check

        logger.info("Added nickname config", { userId, guildId, nickname });
    } catch (error) {
        logger.error("Error adding config:", error);
        Toasts.show({
            message: "Failed to save nickname configuration",
            id: Toasts.genId(),
            type: Toasts.Type.FAILURE
        });
    }
}

function removeConfig(userId: string, guildId: string) {
    try {
        if (!userId || !guildId || typeof userId !== "string" || typeof guildId !== "string") {
            logger.warn("Invalid parameters for removeConfig", { userId, guildId });
            return;
        }

        const configs = getConfigs();
        if (!Array.isArray(configs)) {
            logger.error("Invalid configs format");
            return;
        }

        const filtered = configs.filter(c => c && !(c.userId === userId && c.guildId === guildId));
        saveConfigs(filtered);

        logger.info("Removed nickname config", { userId, guildId });
    } catch (error) {
        logger.error("Error removing config:", error);
    }
}

// UI Components
function NicknameIcon() {
    return (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z" />
        </svg>
    );
}

function openNicknameModal(userId: string, guildId: string, currentNick: string | null, existingNick: string | null) {
    try {
        logger.info("Opening nickname modal", { userId, guildId, currentNick, existingNick });

        if (!userId || !guildId || typeof userId !== "string" || typeof guildId !== "string") {
            logger.warn("Invalid parameters for openNicknameModal", { userId, guildId });
            Toasts.show({
                message: "Invalid user or guild information",
                id: Toasts.genId(),
                type: Toasts.Type.FAILURE
            });
            return;
        }

        // Check if required modules are available
        if (!openModal) {
            logger.error("openModal function not available");
            Toasts.show({
                message: "Modal system not available",
                id: Toasts.genId(),
                type: Toasts.Type.FAILURE
            });
            return;
        }

        const user = safeGetUser(userId);
        const guild = safeGetGuild(guildId);

        logger.debug("Modal data prepared", {
            user: user?.username,
            guild: guild?.name,
            currentNick,
            existingNick
        });

        // Use a simpler approach without React.useState
        let nicknameValue = existingNick || currentNick || "";

        openModal((props: ModalProps) => {
            return (
                <ErrorBoundary
                    noop
                    onError={errorData => {
                        logger.error("Error in nickname modal:", errorData.error);
                    }}
                >
                    <ModalRoot {...props}>
                        <ModalHeader>
                            <Forms.FormTitle tag="h2">Set Auto Nickname</Forms.FormTitle>
                            <ModalCloseButton onClick={props.onClose} />
                        </ModalHeader>
                        <ModalContent>
                            <Forms.FormText style={{ marginBottom: "16px" }}>
                                <strong>User:</strong> {user?.username || userId || "Unknown"}
                                <br />
                                <strong>Guild:</strong> {guild?.name || guildId || "Unknown"}
                                <br />
                                <strong>Current Nickname:</strong> {currentNick || "none"}
                            </Forms.FormText>
                            <Forms.FormTitle tag="h5">Nickname to Auto-Enforce</Forms.FormTitle>
                            <TextInput
                                placeholder="Enter nickname to auto-enforce"
                                defaultValue={nicknameValue}
                                onChange={(value: string) => {
                                    try {
                                        if (typeof value === "string") {
                                            nicknameValue = value;
                                        }
                                    } catch (error) {
                                        logger.error("Error in nickname input:", error);
                                    }
                                }}
                            />
                        </ModalContent>
                        <ModalFooter>
                            <Button
                                color={Button.Colors.BRAND}
                                onClick={() => {
                                    try {
                                        const trimmed = nicknameValue?.trim?.() || "";
                                        logger.info("Modal action triggered", { trimmed, existingNick });

                                        if (trimmed) {
                                            addConfig(userId, guildId, trimmed);
                                            Toasts.show({
                                                message: `Auto nickname set to: ${trimmed}`,
                                                id: Toasts.genId(),
                                                type: Toasts.Type.SUCCESS
                                            });
                                        } else if (existingNick) {
                                            removeConfig(userId, guildId);
                                            Toasts.show({
                                                message: "Auto nickname disabled",
                                                id: Toasts.genId(),
                                                type: Toasts.Type.SUCCESS
                                            });
                                        } else {
                                            Toasts.show({
                                                message: "Please enter a nickname",
                                                id: Toasts.genId(),
                                                type: Toasts.Type.FAILURE
                                            });
                                            return;
                                        }
                                        props.onClose();
                                    } catch (error) {
                                        logger.error("Error in modal action:", error);
                                        Toasts.show({
                                            message: "Failed to save nickname configuration",
                                            id: Toasts.genId(),
                                            type: Toasts.Type.FAILURE
                                        });
                                    }
                                }}
                            >
                                {existingNick ? "Update" : "Set"}
                            </Button>
                            <Button
                                color={Button.Colors.PRIMARY}
                                look={Button.Looks.LINK}
                                onClick={props.onClose}
                            >
                                Cancel
                            </Button>
                        </ModalFooter>
                    </ModalRoot>
                </ErrorBoundary>
            );
        });

        logger.info("Modal opened successfully");
    } catch (error) {
        logger.error("Error opening modal:", error);
        Toasts.show({
            message: "Failed to open nickname modal",
            id: Toasts.genId(),
            type: Toasts.Type.FAILURE
        });
    }
}

// Context Menu
const UserContext: NavContextMenuPatchCallback = (children, { user, guildId }: UserContextProps) => {
    try {
        if (!children || !Array.isArray(children)) {
            logger.warn("Invalid children in UserContext");
            return;
        }
        if (!user || !user.id || typeof user.id !== "string") {
            logger.warn("Invalid user in UserContext", { user });
            return;
        }
        if (!guildId || typeof guildId !== "string") {
            logger.warn("Invalid guildId in UserContext", { guildId });
            return;
        }

        // Check if UserStore is available before using it
        if (!UserStore) {
            logger.debug("UserStore not available in UserContext");
            return;
        }

        const currentUser = UserStore.getCurrentUser?.();
        if (currentUser?.id === user.id) {
            logger.debug("Skipping self in UserContext");
            return;
        }

        const config = findConfig(user.id, guildId);
        const isActive = !!config;

        children.splice(-1, 0, (
            <Menu.MenuGroup key="auto-nickname-group">
                <Menu.MenuItem
                    id="auto-nickname-set"
                    label={isActive ? "Change Auto Nickname" : "Set Auto Nickname"}
                    action={() => {
                        try {
                            logger.info("Context menu action triggered", { userId: user.id, guildId });

                            // Add a small delay to ensure everything is ready
                            setTimeout(() => {
                                try {
                                    const currentNick = safeGetNick(guildId, user.id);
                                    logger.debug("Opening modal with data", { currentNick, config: config?.nickname });
                                    openNicknameModal(user.id, guildId, currentNick, config?.nickname || null);
                                } catch (error) {
                                    logger.error("Error in delayed context menu action:", error);
                                    Toasts.show({
                                        message: "Failed to open nickname settings",
                                        id: Toasts.genId(),
                                        type: Toasts.Type.FAILURE
                                    });
                                }
                            }, 50);
                        } catch (error) {
                            logger.error("Error in context menu action:", error);
                            Toasts.show({
                                message: "Failed to open nickname settings",
                                id: Toasts.genId(),
                                type: Toasts.Type.FAILURE
                            });
                        }
                    }}
                    icon={NicknameIcon}
                />
                {isActive && config && (
                    <Menu.MenuItem
                        id="auto-nickname-remove"
                        label={`Remove Auto Nickname (${config.nickname || ""})`}
                        action={() => {
                            try {
                                removeConfig(user.id, guildId);
                                Toasts.show({
                                    message: "Auto nickname disabled",
                                    id: Toasts.genId(),
                                    type: Toasts.Type.SUCCESS
                                });
                            } catch (error) {
                                logger.error("Error removing config:", error);
                            }
                        }}
                        icon={NicknameIcon}
                    />
                )}
            </Menu.MenuGroup>
        ));
    } catch (error) {
        logger.error("Error in context menu:", error);
    }
};

// Plugin definition
export default definePlugin({
    name: "AutoNicknameChanger",
    description: "Automatically enforces specific nicknames for users. When a user changes their nickname, it will be automatically changed back to the configured nickname.",
    authors: [{ name: "penthe", id: 0n }],

    settings,

    contextMenus: {
        "user-context": UserContext
    },

    flux: {
        GUILD_MEMBER_PROFILE_UPDATE({ guildId, guildMember }: { guildId: string; guildMember: any; }) {
            try {
                logger.debug("GUILD_MEMBER_PROFILE_UPDATE received", { guildId, guildMember });

                // Early validation
                if (!guildId || !guildMember || typeof guildId !== "string") {
                    logger.debug("Invalid GUILD_MEMBER_PROFILE_UPDATE data", { guildId, guildMember });
                    return;
                }

                // Check if required modules are loaded
                if (!GuildMemberStore) {
                    logger.debug("GuildMemberStore not loaded yet, skipping flux event");
                    return;
                }

                // Try both userId and user.id formats
                const userId = guildMember.userId || guildMember.user?.id;
                if (!userId || typeof userId !== "string") {
                    logger.debug("No valid userId in GUILD_MEMBER_PROFILE_UPDATE", { guildMember });
                    return;
                }

                logger.debug("Processing user", { userId, guildId });

                const config = findConfig(userId, guildId);
                if (!config) {
                    logger.debug("No config found for user in GUILD_MEMBER_PROFILE_UPDATE", { userId, guildId });
                    return;
                }

                logger.debug("Found config for user", { userId, guildId, config });

                // Check if nickname changed - use safe method
                const currentNick = guildMember.nick ?? guildMember.user?.nick ?? safeGetNick(guildId, userId) ?? null;
                logger.debug("Current nickname check", { userId, guildId, currentNick, targetNick: config.nickname });

                if (currentNick !== config.nickname) {
                    logger.info("Nickname change detected in flux event", { userId, guildId, currentNick, targetNick: config.nickname });
                    // Use setTimeout to avoid blocking the flux event
                    setTimeout(() => {
                        try {
                            logger.info("Executing delayed nickname enforcement", { userId, guildId, targetNick: config.nickname });
                            checkAndEnforceNickname(userId, guildId, config.nickname);
                        } catch (error) {
                            logger.error("Error in delayed nickname enforcement:", error);
                        }
                    }, 100); // Reduced delay to 100ms for faster response
                } else {
                    logger.debug("Nickname is already correct", { userId, guildId, currentNick });
                }
            } catch (error) {
                logger.error("Error in GUILD_MEMBER_PROFILE_UPDATE:", error);
            }
        }
    },

    
start() {
    try {
        logger.info("Starting AutoNicknameChanger plugin");

        // İlk yüklemede hemen çalıştır
        const enforceAll = () => {
            try {
                const configs = getConfigs();
                if (!configs?.length) return;
                logger.info(`Running immediate nickname enforcement for ${configs.length} configs`);
                for (const cfg of configs) {
                    checkAndEnforceNickname(cfg.userId, cfg.guildId, cfg.nickname);
                }
            } catch (err) {
                logger.error("Error in immediate enforcement:", err);
            }
        };

        // Modüller yüklendiğinde hemen çalışsın
        setTimeout(enforceAll, 2000);
        // 10 saniye sonra bir daha kontrol et (gecikmiş modüller için)
        setTimeout(enforceAll, 10000);

        // Sürekli kontrol döngüsü (asıl otomatik sistem)
        const intervalTime = Math.max(1000, settings.store.periodicCheckInterval * 1000);
        const interval = setInterval(() => {
            try {
                const configs = getConfigs();
                for (const config of configs) {
                    if (!config?.userId || !config?.guildId || !config?.nickname) continue;
                    checkAndEnforceNickname(config.userId, config.guildId, config.nickname);
                }
            } catch (err) {
                logger.error("Error in nickname check loop:", err);
            }
        }, intervalTime);

        (this as any).checkInterval = interval;
        logger.info("AutoNicknameChanger continuous loop started", { interval: intervalTime });
    } catch (error) {
        logger.error("Error starting plugin:", error);
    }
}
,

    stop() {
        try {
            logger.info("Stopping AutoNicknameChanger plugin");

            const interval = (this as any).checkInterval;
            if (interval) {
                clearInterval(interval);
                (this as any).checkInterval = null;
                logger.debug("Cleared periodic check interval");
            }

            const { cleanupInterval } = (this as any);
            if (cleanupInterval) {
                clearInterval(cleanupInterval);
                (this as any).cleanupInterval = null;
                logger.debug("Cleared cleanup interval");
            }

            // Clean up rate limit map
            rateLimitMap.clear();
            logger.debug("Cleared rate limit map");

            logger.info("AutoNicknameChanger plugin stopped successfully");
        } catch (error) {
            logger.error("Error stopping plugin:", error);
        }
    }
});
