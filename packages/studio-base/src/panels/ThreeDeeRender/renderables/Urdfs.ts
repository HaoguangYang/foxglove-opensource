// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { vec3 } from "gl-matrix";
import i18next from "i18next";
import * as _ from "lodash-es";
import * as THREE from "three";
import { v4 as uuidv4 } from "uuid";

import { filterMap } from "@foxglove/den/collection";
import { UrdfGeometryMesh, UrdfRobot, UrdfVisual, parseRobot } from "@foxglove/den/urdf";
import Logger from "@foxglove/log";
import {
  SettingsTreeAction,
  SettingsTreeChildren,
  SettingsTreeField,
  SettingsTreeFields,
  SettingsTreeNodeActionItem,
} from "@foxglove/studio";
import { makeRgba, stringToRgba } from "@foxglove/studio-base/panels/ThreeDeeRender/color";
import { eulerToQuaternion } from "@foxglove/studio-base/util/geometry";
import isDesktopApp from "@foxglove/studio-base/util/isDesktopApp";

import {
  createEmbeddedUrdfPackageFromFiles,
  EmbeddedUrdfPackageResolver,
  makeEmbeddedUrdfUrl,
} from "./EmbeddedUrdfPackage";
import type { EmbeddedUrdfPackage } from "./EmbeddedUrdfPackage";
import { LocalModelUrlReferences } from "./LocalModelUrlReferences";
import {
  applyUrdfJointStateTransforms,
  normalizeUrdfJointState,
} from "./UrdfJointStateTransforms";
import type {
  JointPosition,
  NormalizedJointState,
  UrdfJointTransform,
} from "./UrdfJointStateTransforms";
import { UrdfLoadGeneration } from "./UrdfLoadGeneration";
import { RenderableCube } from "./markers/RenderableCube";
import { RenderableCylinder } from "./markers/RenderableCylinder";
import { RenderableMeshResource } from "./markers/RenderableMeshResource";
import { RenderableSphere } from "./markers/RenderableSphere";
import { missingTransformMessage, MISSING_TRANSFORM } from "./transforms";
import type { AnyRendererSubscription, IRenderer } from "../IRenderer";
import { BaseUserData, Renderable } from "../Renderable";
import { PartialMessageEvent, SceneExtension, onlyLastByTopicMessage } from "../SceneExtension";
import { SettingsTreeEntry } from "../SettingsManager";
import { JOINTSTATES_DATATYPES } from "../foxglove";
import {
  ColorRGBA,
  JOINTSTATE_DATATYPES,
  Marker,
  MarkerAction,
  MarkerType,
  Quaternion,
  Vector3,
} from "../ros";
import {
  BaseSettings,
  CustomLayerSettings,
  PRECISION_DEGREES,
  PRECISION_DISTANCE,
} from "../settings";
import { Pose, makePose, TransformTree } from "../transforms";
import { updatePose } from "../updatePose";

const log = Logger.getLogger(__filename);

const LAYER_ID = "foxglove.Urdf";
const TOPIC_NAME = "/robot_description";

/** ID of fake "topic" used to represent the /robot_description parameter */
const PARAM_KEY = "param:/robot_description";
/** Standard parameter name used for URDF data in ROS */
const PARAM_NAME = "/robot_description";
const PARAM_DISPLAY_NAME = "/robot_description (parameter)";

const VALID_SRC_ERR = "ValidSrc";
const FETCH_URDF_ERR = "FetchUrdf";
const PARSE_URDF_ERR = "ParseUrdf";

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
const DEFAULT_COLOR_STR = "#ffffff";
const DEFAULT_COLOR = stringToRgba(makeRgba(), DEFAULT_COLOR_STR);
const VEC3_ONE = { x: 1, y: 1, z: 1 };
const XYZ_LABEL: [string, string, string] = ["X", "Y", "Z"];
const RPY_LABEL: [string, string, string] = ["R", "P", "Y"];

export type LayerSettingsUrdf = BaseSettings & {
  instanceId: string; // This will be set to the topic name
  displayMode: "auto" | "visual" | "collision";
  label: string;
  fallbackColor?: string;
};

export type LayerSettingsCustomUrdf = CustomLayerSettings & {
  layerId: "foxglove.Urdf";
  sourceType: "url" | "filePath" | "localFiles" | "param" | "topic";
  url?: string;
  filePath?: string;
  /** Portable browser-imported URDF package. It contains bytes, never Files or file handles. */
  localPackage?: EmbeddedUrdfPackage;
  parameter?: string;
  topic?: string;
  /** Explicit JointState source used to animate this custom URDF's non-fixed links. */
  jointStateTopic?: string;
  framePrefix: string;
  displayMode: "auto" | "visual" | "collision";
  fallbackColor?: string;
};

type LocalUrdfImportTrigger = "source-change" | "manual";

export type LocalUrdfImportPlan = {
  openPicker: boolean;
  clearBeforePicker: boolean;
};

export function getLocalFilesUrdfSettings(
  sourceType: LayerSettingsCustomUrdf["sourceType"],
): { actions: SettingsTreeNodeActionItem[] } {
  return {
    actions:
      sourceType === "localFiles"
        ? [
            {
              type: "action",
              id: "import-local-files",
              label: "Choose URDF package",
              icon: "FolderOpen",
              display: "inline",
            },
          ]
        : [],
  };
}

export function getLocalUrdfImportPlan(
  trigger: LocalUrdfImportTrigger,
  settings: Pick<LayerSettingsCustomUrdf, "sourceType" | "localPackage">,
): LocalUrdfImportPlan {
  const needsPackage = settings.sourceType === "localFiles" && settings.localPackage == undefined;
  return trigger === "source-change"
    ? { openPicker: needsPackage, clearBeforePicker: needsPackage }
    : { openPicker: true, clearBeforePicker: false };
}

const DEFAULT_SETTINGS: LayerSettingsUrdf = {
  visible: false,
  frameLocked: true,
  instanceId: "invalid",
  displayMode: "auto",
  label: "URDF",
  fallbackColor: DEFAULT_COLOR_STR,
};

const DEFAULT_CUSTOM_SETTINGS: LayerSettingsCustomUrdf = {
  visible: true,
  frameLocked: true,
  label: "URDF",
  instanceId: "invalid",
  layerId: LAYER_ID,
  sourceType: "url",
  url: "",
  filePath: "",
  parameter: "",
  topic: "",
  jointStateTopic: "",
  framePrefix: "",
  displayMode: "auto",
  fallbackColor: DEFAULT_COLOR_STR,
};
const URDF_TOPIC_SCHEMAS = new Set<string>(["std_msgs/String", "std_msgs/msg/String"]);
const JOINT_STATE_TOPIC_SCHEMAS = new Set([...JOINTSTATE_DATATYPES, ...JOINTSTATES_DATATYPES]);
const MAX_PENDING_JOINT_STATES_PER_LAYER = 2_000;

const tempVec3a = new THREE.Vector3();
const tempVec3b = new THREE.Vector3();
const tempQuaternion1 = new THREE.Quaternion();
const tempQuaternion2 = new THREE.Quaternion();
const tempEuler = new THREE.Euler();

export type UrdfUserData = BaseUserData & {
  settings: LayerSettingsUrdf | LayerSettingsCustomUrdf;
  fetching?: { url: string; control: AbortController };
  urdf: string | undefined;
  sourceType: LayerSettingsCustomUrdf["sourceType"] | undefined;
  parameter: string | undefined;
  renderables: Map<string, Renderable>;
};

enum EmbeddedMaterialUsage {
  Use,
  Ignore,
}

type TransformData = UrdfJointTransform;

type ParsedUrdf = {
  robot: UrdfRobot;
  frames: string[];
  transforms: TransformData[];
};

export class UrdfRenderable extends Renderable<UrdfUserData> {
  public override dispose(): void {
    this.removeChildren();
    this.userData.urdf = undefined;
    super.dispose();
  }

  public removeChildren(): void {
    for (const childRenderable of this.userData.renderables.values()) {
      childRenderable.dispose();
    }
    this.children.length = 0;
    this.userData.renderables.clear();
  }
}

export class Urdfs extends SceneExtension<UrdfRenderable> {
  public static extensionId = "foxglove.Urdfs";
  #framesByInstanceId = new Map<string, string[]>();
  #transformsByInstanceId = new Map<string, TransformData[]>();
  #jointStatesByInstanceId = new Map<string, Map<string, JointPosition>>();
  #pendingJointStatesByInstanceId = new Map<string, NormalizedJointState[]>();
  #jointStateTransformOwners = new Set<string>();
  #textDecoder = new TextDecoder();
  #urdfsByTopic = new Map<string, string>();
  #loadGenerations = new UrdfLoadGeneration();
  #localModelUrls = new LocalModelUrlReferences();

  public constructor(renderer: IRenderer, name: string = Urdfs.extensionId) {
    super(name, renderer);

    renderer.on("parametersChange", this.#handleParametersChange);
    renderer.addCustomLayerAction({
      layerId: LAYER_ID,
      label: i18next.t("threeDee:addURDF"),
      icon: "PrecisionManufacturing",
      handler: this.#handleAddUrdf,
    });

    // Load existing URDF layers from the config
    for (const [instanceId, entry] of Object.entries(renderer.config.layers)) {
      if (entry?.layerId === LAYER_ID) {
        this.#loadUrdf({ instanceId, urdf: undefined });
      }
    }
  }

  public override dispose(): void {
    for (const instanceId of this.renderables.keys()) {
      this.#loadGenerations.begin(instanceId);
      this.#clearJointStateLayer(instanceId, true, false);
    }
    super.dispose();
    for (const url of this.#localModelUrls.clear()) {
      this.renderer.modelCache.evict(url);
    }
  }

  public override getSubscriptions(): readonly AnyRendererSubscription[] {
    return [
      {
        type: "topic",
        topicName: TOPIC_NAME,
        subscription: {
          handler: this.#handleRobotDescription,
          filterQueue: onlyLastByTopicMessage,
        },
      },

      {
        type: "schema",
        schemaNames: JOINT_STATE_TOPIC_SCHEMAS,
        subscription: {
          // Joint states are transform history. Keeping every queued message and preloading lets
          // replay reconstruct link poses at the selected playback time instead of only the latest.
          shouldSubscribe: this.#shouldSubscribeJointState,
          handler: this.#handleJointState,
          preload: true,
        },
      },

      {
        type: "schema",
        schemaNames: URDF_TOPIC_SCHEMAS,
        subscription: {
          shouldSubscribe: this.#shouldSubscribe,
          handler: this.#handleRobotDescription,
          filterQueue: onlyLastByTopicMessage,
        },
      },
    ];
  }

  public override settingsNodes(): SettingsTreeEntry[] {
    const entries: SettingsTreeEntry[] = [];
    const baseDisplayModeField: SettingsTreeField = {
      label: "Display mode",
      input: "select",
      options: [
        {
          label: "Auto",
          value: "auto",
        },
        {
          label: "Visual",
          value: "visual",
        },
        {
          label: "Collision",
          value: "collision",
        },
      ],
    };
    const baseFallbackColorField: SettingsTreeField = {
      label: "Color",
      help: "Fallback color used in case a link does not specify any color itself",
      input: "rgb",
    };

    // /robot_description topic entry
    const topic = this.renderer.topicsByName?.get(TOPIC_NAME);
    if (topic != undefined) {
      const config = (this.renderer.config.topics[TOPIC_NAME] ?? {}) as Partial<LayerSettingsUrdf>;
      const fields: SettingsTreeFields = {
        displayMode: {
          ...baseDisplayModeField,
          value: config.displayMode ?? DEFAULT_SETTINGS.displayMode,
        },
        fallbackColor: {
          ...baseFallbackColorField,
          value: config.fallbackColor ?? DEFAULT_SETTINGS.fallbackColor,
        },
      };
      entries.push({
        path: ["topics", TOPIC_NAME],
        node: {
          label: TOPIC_NAME,
          icon: "PrecisionManufacturing",
          fields,
          visible: config.visible ?? DEFAULT_SETTINGS.visible,
          handler: this.#handleTopicSettingsAction,
          children: urdfChildren(
            this.#transformsByInstanceId.get(TOPIC_NAME),
            this.renderer.transformTree,
            this.#jointStatesByInstanceId.get(TOPIC_NAME),
          ),
        },
      });
    }

    // /robot_description parameter entry
    const parameter = this.renderer.parameters?.get(PARAM_NAME);
    if (parameter != undefined) {
      const config = (this.renderer.config.topics[PARAM_KEY] ?? {}) as Partial<LayerSettingsUrdf>;

      const fields: SettingsTreeFields = {
        displayMode: {
          ...baseDisplayModeField,
          value: config.displayMode ?? DEFAULT_SETTINGS.displayMode,
        },
        fallbackColor: {
          ...baseFallbackColorField,
          value: config.fallbackColor ?? DEFAULT_SETTINGS.fallbackColor,
        },
      };

      entries.push({
        path: ["topics", PARAM_KEY],
        node: {
          label: PARAM_DISPLAY_NAME,
          icon: "PrecisionManufacturing",
          fields,
          visible: config.visible ?? DEFAULT_SETTINGS.visible,
          handler: this.#handleTopicSettingsAction,
          children: urdfChildren(
            this.#transformsByInstanceId.get(PARAM_KEY),
            this.renderer.transformTree,
            this.#jointStatesByInstanceId.get(PARAM_KEY),
          ),
        },
      });
    }

    // Custom layer entries
    for (const [instanceId, layerConfig] of Object.entries(this.renderer.config.layers)) {
      if (layerConfig?.layerId === LAYER_ID) {
        const config = layerConfig as Partial<LayerSettingsCustomUrdf>;

        const fields: SettingsTreeFields = {
          sourceType: {
            label: "Source",
            input: "select",
            value: config.sourceType ?? DEFAULT_CUSTOM_SETTINGS.sourceType,
            options: [
              {
                label: "URL",
                value: "url",
              },
              {
                label: "File path (Desktop only)",
                value: "filePath",
                disabled: !isDesktopApp(),
              },
              {
                label: "Local files (Browser)",
                value: "localFiles",
              },
              {
                label: "Parameter",
                value: "param",
              },
              {
                label: "Topic",
                value: "topic",
              },
            ],
          },
          url:
            (config.sourceType ?? DEFAULT_CUSTOM_SETTINGS.sourceType) === "url"
              ? {
                  label: "URL",
                  input: "string",
                  placeholder: "package://",
                  help: "package:// URL or http(s) URL pointing to a Unified Robot Description Format (URDF) XML file",
                  value: config.url ?? DEFAULT_CUSTOM_SETTINGS.url,
                }
              : undefined,
          filePath:
            config.sourceType === "filePath"
              ? {
                  label: "File path",
                  input: "string",
                  help: "Absolute file path (desktop app only)",
                  value: config.filePath ?? DEFAULT_CUSTOM_SETTINGS.filePath,
                  disabled: !isDesktopApp(),
                }
              : undefined,
          localPackage:
            config.sourceType === "localFiles"
              ? {
                  label: "Imported package",
                  input: "string",
                  value: config.localPackage?.packageName ?? "No package selected",
                  help: "Choose a directory package to embed its URDF and assets in this layout",
                  readonly: true,
                }
              : undefined,
          topic:
            config.sourceType === "topic"
              ? {
                  label: "Topic",
                  input: "autocomplete",
                  value: config.topic ?? DEFAULT_CUSTOM_SETTINGS.topic,
                  items: filterMap(this.renderer.topics ?? [], (_topic) =>
                    URDF_TOPIC_SCHEMAS.has(_topic.schemaName) ? _topic.name : undefined,
                  ),
                }
              : undefined,
          jointStateTopic: {
            label: "Joint state topic",
            input: "autocomplete",
            help: "Explicitly animates this URDF's non-fixed link frames. Leave empty when external TF drives those frames; do not use both sources for the same links.",
            value: config.jointStateTopic ?? DEFAULT_CUSTOM_SETTINGS.jointStateTopic,
            items: filterMap(this.renderer.topics ?? [], (_topic) =>
              JOINT_STATE_TOPIC_SCHEMAS.has(_topic.schemaName) ? _topic.name : undefined,
            ),
          },
          parameter:
            config.sourceType === "param"
              ? {
                  label: "Parameter",
                  input: "autocomplete",
                  value: config.parameter ?? DEFAULT_CUSTOM_SETTINGS.parameter,
                  items: filterMap(this.renderer.parameters ?? [], ([paramName, value]) =>
                    typeof value === "string" ? paramName : undefined,
                  ),
                }
              : undefined,
          label: {
            label: "Label",
            input: "string",
            value: config.label ?? DEFAULT_CUSTOM_SETTINGS.label,
          },
          framePrefix: {
            label: "Frame prefix",
            input: "string",
            help: "Prefix to apply to all frame names (also often called tfPrefix)",
            placeholder: "Frame prefix",
            value: config.framePrefix ?? "",
          },
          displayMode: {
            ...baseDisplayModeField,
            value: config.displayMode ?? DEFAULT_CUSTOM_SETTINGS.displayMode,
          },
          fallbackColor: {
            ...baseFallbackColorField,
            value: config.fallbackColor ?? DEFAULT_SETTINGS.fallbackColor,
          },
        };

        entries.push({
          path: ["layers", instanceId],
          node: {
            label: config.label ?? "Grid",
            icon: "PrecisionManufacturing",
            fields,
            visible: config.visible ?? DEFAULT_CUSTOM_SETTINGS.visible,
            actions: [
              ...getLocalFilesUrdfSettings(
                config.sourceType ?? DEFAULT_CUSTOM_SETTINGS.sourceType,
              ).actions,
              { type: "action", id: "duplicate", label: "Duplicate" },
              { type: "action", id: "delete", label: "Delete" },
            ],
            order: layerConfig.order,
            handler: this.#handleLayerSettingsAction,
            children: urdfChildren(
              this.#transformsByInstanceId.get(instanceId),
              this.renderer.transformTree,
              this.#jointStatesByInstanceId.get(instanceId),
            ),
          },
        });
      }
    }

    return entries;
  }

  public override removeAllRenderables(): void {
    // The transform tree is cleared on seek. Keeping a future joint value here would cause
    // #refreshTransforms to resurrect it at an earlier playback time.
    this.#jointStatesByInstanceId.clear();
    this.#pendingJointStatesByInstanceId.clear();
    // Renderer only clears the TransformTree on backward seek. Keep owner records here because
    // forward seek/clear still retains synthetic samples that later source/topic changes must remove.
    // Re-add coordinate frames and transforms since the scene has been cleared
    this.#refreshTransforms();
  }

  /**
   * Re-add coordinate frames and transforms corresponding to existing custom URDFs
   */
  #refreshTransforms() {
    for (const [instanceId, frames] of this.#framesByInstanceId) {
      this.#loadFrames(instanceId, frames);
    }
    for (const [instanceId, transforms] of this.#transformsByInstanceId) {
      this.#loadTransforms(instanceId, transforms);
    }
  }

  public override startFrame(
    currentTime: bigint,
    renderFrameId: string,
    fixedFrameId: string,
  ): void {
    for (const renderable of this.renderables.values()) {
      const path = renderable.userData.settingsPath;
      let hasTfError = false;

      renderable.visible = renderable.userData.settings.visible;
      if (!renderable.visible) {
        this.renderer.settings.errors.clearPath(path);
        continue;
      }

      // UrdfRenderables always stay at the origin. Their children renderables
      // are individually updated since each child exists in a different frame
      for (const childRenderable of renderable.userData.renderables.values()) {
        const srcTime = currentTime;
        const frameId = childRenderable.userData.frameId;
        const updated = updatePose(
          childRenderable,
          this.renderer.transformTree,
          renderFrameId,
          fixedFrameId,
          frameId,
          currentTime,
          srcTime,
        );
        if (!updated) {
          const message = missingTransformMessage(renderFrameId, fixedFrameId, frameId);
          this.renderer.settings.errors.add(path, MISSING_TRANSFORM, message);
          hasTfError = true;
        }
      }

      if (!hasTfError) {
        this.renderer.settings.errors.remove(path, MISSING_TRANSFORM);
      }
    }
  }

  #handleTopicSettingsAction = (action: SettingsTreeAction): void => {
    if (action.action === "update") {
      this.#handleSettingsUpdate(action);
      return;
    }
  };

  #handleLayerSettingsAction = (action: SettingsTreeAction): void => {
    const path = action.payload.path;

    // Handle menu actions (duplicate / delete)
    if (action.action === "perform-node-action" && path.length === 2) {
      const instanceId = path[1]!;
      if (action.payload.id === "delete") {
        this.#beginLoad(instanceId);
        this.#clearJointStateLayer(instanceId, true, false);
        // Remove this instance from the config
        this.renderer.updateConfig((draft) => {
          delete draft.layers[instanceId];
        });

        // Remove the renderable
        const renderable = this.renderables.get(instanceId);
        if (renderable) {
          renderable.dispose();
          this.remove(renderable);
          this.renderables.delete(instanceId);
        }
        this.#releaseLocalModels(instanceId);

        // Remove transforms from the TF tree
        const transforms = this.#transformsByInstanceId.get(instanceId);
        if (transforms) {
          for (const { parent, child } of transforms) {
            this.renderer.removeTransform(child, parent, 0n);
          }
        }
        this.#framesByInstanceId.delete(instanceId);
        this.#transformsByInstanceId.delete(instanceId);
        this.#jointStatesByInstanceId.delete(instanceId);

        // Re-add coordinate frames in case the deleted URDF shared frame names with other URDFs
        this.#refreshTransforms();

        // Update the settings tree
        this.updateSettingsTree();
        this.renderer.updateCustomLayersCount();
      } else if (action.payload.id === "import-local-files") {
        const settings = this.renderer.config.layers[instanceId] as
          | Partial<LayerSettingsCustomUrdf>
          | undefined;
        void this.#importLocalUrdfPackage(
          instanceId,
          getLocalUrdfImportPlan("manual", {
            sourceType: settings?.sourceType ?? DEFAULT_CUSTOM_SETTINGS.sourceType,
            localPackage: settings?.localPackage,
          }),
        );
      } else if (action.payload.id === "duplicate") {
        const newInstanceId = uuidv4();
        const config = {
          ...this.renderer.config.layers[instanceId],
          instanceId: newInstanceId,
        };

        // Add the new instance to the config
        this.renderer.updateConfig((draft) => {
          draft.layers[newInstanceId] = config;
        });

        // Add the URDF renderable
        const renderable = this.renderables.get(instanceId);
        this.#loadUrdf({ instanceId: newInstanceId, urdf: renderable?.userData.urdf });

        // Update the settings tree
        this.updateSettingsTree();
        this.renderer.updateCustomLayersCount();
      }
    } else if (action.action === "update") {
      this.#handleSettingsUpdate(action);
    }
  };

  async #importLocalUrdfPackage(instanceId: string, plan: LocalUrdfImportPlan): Promise<void> {
    const settingsPath = ["layers", instanceId];
    const generation = this.#beginLoad(instanceId);
    if (plan.clearBeforePicker) {
      this.#loadUrdf({ instanceId, urdf: undefined, forceReload: true, generation });
    }
    try {
      const selected = await selectLocalUrdfPackageFiles();
      if (!selected || !this.#loadGenerations.isCurrent(instanceId, generation)) {
        return;
      }
      const urdfPaths = selected.files
        .map(({ path }) => path)
        .filter((path) => /\.(urdf|xacro)$/iu.test(path));
      if (urdfPaths.length !== 1) {
        throw new Error(
          `Expected exactly one .urdf or .xacro file in the selected directory, found ${urdfPaths.length}`,
        );
      }

      const localPackage = await createEmbeddedUrdfPackageFromFiles({
        id: uuidv4(),
        packageName: selected.packageName,
        urdfPath: urdfPaths[0]!,
        files: selected.files,
      });
      if (!this.#loadGenerations.isCurrent(instanceId, generation)) {
        return;
      }
      this.renderer.updateConfig((draft) => {
        const layer = draft.layers[instanceId] as Partial<LayerSettingsCustomUrdf> | undefined;
        if (layer) {
          layer.sourceType = "localFiles";
          layer.localPackage = localPackage;
        }
      });
      this.renderer.settings.errors.remove(settingsPath, VALID_SRC_ERR);
      this.#loadUrdf({ instanceId, urdf: undefined, forceReload: true, generation });
      this.updateSettingsTree();
    } catch (error) {
      if (!this.#loadGenerations.isCurrent(instanceId, generation)) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.renderer.settings.errors.add(
        settingsPath,
        VALID_SRC_ERR,
        `Failed to import local URDF package: ${message}`,
      );
    }
  }

  #handleSettingsUpdate = (action: { action: "update" } & SettingsTreeAction): void => {
    const path = action.payload.path;

    if (path.length === 5 && path[2] === "joints") {
      // ["layers", instanceId, "joints", jointName, "manual"]
      const instanceId = path[1]!;
      const jointName = path[3]!;
      const transforms = this.#transformsByInstanceId.get(instanceId);
      if (!transforms) {
        return;
      }

      const transformData = transforms.find((t) => t.joint.name === jointName);
      if (!transformData) {
        return;
      }

      const joint = transformData.joint;
      const frame = this.renderer.transformTree.getOrCreateFrame(transformData.child);
      const frameKey = `frame:${frame.id}`;
      const isAngular = joint.jointType === "revolute" || joint.jointType === "continuous";
      const axis = tempVec3a.set(joint.axis.x, joint.axis.y, joint.axis.z);

      if (isAngular) {
        const degrees = action.payload.value as number;
        const quaternion = tempQuaternion1.setFromAxisAngle(axis, degrees * DEG2RAD);
        const euler = tempEuler.setFromQuaternion(quaternion);
        frame.offsetEulerDegrees = [euler.x * RAD2DEG, euler.y * RAD2DEG, euler.z * RAD2DEG];
        this.saveSetting(["transforms", frameKey, "rpyCoefficient"], frame.offsetEulerDegrees);
      } else {
        const scale = action.payload.value as number;
        axis.multiplyScalar(scale);
        frame.offsetPosition = [axis.x, axis.y, axis.z];
        this.saveSetting(["transforms", frameKey, "xyzOffset"], frame.offsetPosition);
      }
    } else if (path.length === 3) {
      // ["layers", instanceId, field]
      const [_layers, instanceId, field] = path as [string, string, string];
      if (
        field === "url" ||
        field === "filePath" ||
        field === "sourceType" ||
        field === "topic" ||
        field === "parameter" ||
        field === "framePrefix" ||
        field === "jointStateTopic"
      ) {
        this.#clearJointStateLayer(instanceId, true, true);
      }
      if (field === "url" || field === "filePath" || field === "sourceType") {
        this.#beginLoad(instanceId);
      }
      this.saveSetting(path, action.payload.value);
      const renderable = this.renderables.get(instanceId);
      let urdf = renderable?.userData.urdf;

      if (field === "url" || field === "filePath") {
        this.#debouncedLoadUrdf({ instanceId, urdf: undefined });
      } else if (field === "parameter") {
        urdf = this.renderer.parameters?.get(action.payload.value as string) as string | undefined;
        this.#debouncedLoadUrdf({ instanceId, urdf, forceReload: true });
      } else if (field === "framePrefix") {
        this.#debouncedLoadUrdf({ instanceId, urdf, forceReload: true });
      } else if (field === "displayMode" || field === "visible" || field === "fallbackColor") {
        this.#loadUrdf({ instanceId, urdf, forceReload: true });
      } else if (field === "sourceType") {
        const sourceType = action.payload.value as LayerSettingsCustomUrdf["sourceType"];
        const settings = this.renderer.config.layers[instanceId] as
          | Partial<LayerSettingsCustomUrdf>
          | undefined;
        const importPlan = getLocalUrdfImportPlan("source-change", {
          sourceType,
          localPackage: settings?.localPackage,
        });
        if (importPlan.openPicker) {
          void this.#importLocalUrdfPackage(instanceId, importPlan);
          return;
        }
        if (sourceType === "topic") {
          urdf = renderable?.userData.topic
            ? this.#urdfsByTopic.get(renderable.userData.topic)
            : undefined;
        } else if (sourceType === "param") {
          urdf = renderable?.userData.parameter
            ? (this.renderer.parameters?.get(renderable.userData.parameter) as string | undefined)
            : undefined;
        } else {
          urdf = undefined;
        }
        this.#loadUrdf({ instanceId, urdf, forceReload: true });
      } else if (field === "topic") {
        urdf = this.#urdfsByTopic.get(action.payload.value as string);
        this.#loadUrdf({ instanceId, urdf });
      } else {
        this.#loadUrdf({ instanceId, urdf });
      }
    }
  };

  #handleRobotDescription = (messageEvent: PartialMessageEvent<{ data: string }>): void => {
    const topic = messageEvent.topic;
    const robotDescription = messageEvent.message.data;
    if (typeof robotDescription !== "string") {
      return;
    }
    this.#urdfsByTopic.set(topic, robotDescription);

    if (topic === TOPIC_NAME) {
      this.#loadUrdf({ instanceId: TOPIC_NAME, urdf: robotDescription });
    }

    // Update custom layer URDFs that subscribe to this topic.
    const subscribedInstanceIds = filterMap(this.renderables, ([instanceId, renderable]) =>
      renderable.userData.sourceType === "topic" && renderable.userData.topic === topic
        ? instanceId
        : undefined,
    );
    for (const instanceId of subscribedInstanceIds) {
      this.#loadUrdf({ instanceId, urdf: robotDescription });
    }
  };

  #shouldSubscribe = (topic: string): boolean => {
    return Array.from(this.renderables.values()).some(
      (renderable) =>
        renderable.userData.sourceType === "topic" && renderable.userData.topic === topic,
    );
  };

  #shouldSubscribeJointState = (topic: string): boolean => {
    return Object.values(this.renderer.config.layers).some(
      (layer) =>
        layer?.layerId === LAYER_ID &&
        (layer as Partial<LayerSettingsCustomUrdf>).jointStateTopic === topic,
    );
  };

  #handleJointState = (messageEvent: PartialMessageEvent<unknown>): void => {
    const jointState = normalizeUrdfJointState(messageEvent.message, messageEvent.receiveTime);
    if (jointState.positions.size === 0) {
      return;
    }

    for (const [instanceId, layer] of Object.entries(this.renderer.config.layers)) {
      if (
        layer?.layerId !== LAYER_ID ||
        (layer as Partial<LayerSettingsCustomUrdf>).jointStateTopic !== messageEvent.topic
      ) {
        continue;
      }
      const transforms = this.#transformsByInstanceId.get(instanceId);
      if (transforms == undefined) {
        this.#queuePendingJointState(instanceId, jointState);
      } else {
        this.#applyJointState(instanceId, transforms, jointState);
      }
    }
  };

  #queuePendingJointState(instanceId: string, jointState: NormalizedJointState): void {
    const pending = this.#pendingJointStatesByInstanceId.get(instanceId) ?? [];
    if (pending.length === MAX_PENDING_JOINT_STATES_PER_LAYER) {
      pending.shift();
    }
    pending.push(jointState);
    this.#pendingJointStatesByInstanceId.set(instanceId, pending);
  }

  #replayPendingJointStates(instanceId: string, transforms: TransformData[]): void {
    const pending = this.#pendingJointStatesByInstanceId.get(instanceId);
    this.#pendingJointStatesByInstanceId.delete(instanceId);
    for (const jointState of pending ?? []) {
      this.#applyJointState(instanceId, transforms, jointState);
    }
  }

  #applyJointState(
    instanceId: string,
    transforms: TransformData[],
    jointState: NormalizedJointState,
  ): void {
    const latestPositions =
      this.#jointStatesByInstanceId.get(instanceId) ?? new Map<string, JointPosition>();
    this.#jointStatesByInstanceId.set(instanceId, latestPositions);
    for (const [name, position] of jointState.positions) {
      const previous = latestPositions.get(name);
      if (previous == undefined || jointState.timestamp >= previous.timestamp) {
        latestPositions.set(name, { timestamp: jointState.timestamp, position });
      }
    }

    const addedCount = applyUrdfJointStateTransforms(
      transforms,
      jointState,
      (parent, child, timestamp, translation, rotation) => {
        this.renderer.addTransform(
          parent,
          child,
          timestamp,
          translation,
          rotation,
          ["layers", instanceId],
          this.#jointStateTransformOwner(instanceId),
        );
      },
    );
    if (addedCount > 0) {
      this.#jointStateTransformOwners.add(instanceId);
    }
  }

  #jointStateTransformOwner(instanceId: string): string {
    return `${this.extensionId}:${instanceId}`;
  }

  #clearJointStateLayer(
    instanceId: string,
    clearPending: boolean,
    restoreStaticTransforms: boolean,
  ): void {
    if (this.#jointStateTransformOwners.delete(instanceId)) {
      this.renderer.removeTransformsByOwner(this.#jointStateTransformOwner(instanceId));
      if (restoreStaticTransforms) {
        this.#restoreStaticTransforms(instanceId);
      }
    }
    this.#jointStatesByInstanceId.delete(instanceId);
    if (clearPending) {
      this.#pendingJointStatesByInstanceId.delete(instanceId);
    }
  }

  #restoreStaticTransforms(instanceId: string): void {
    const transforms = this.#transformsByInstanceId.get(instanceId);
    if (!transforms) {
      return;
    }
    const isTopicOrParam = instanceId === TOPIC_NAME || instanceId === PARAM_KEY;
    const settingsPath = isTopicOrParam ? ["topics", instanceId] : ["layers", instanceId];
    for (const { parent, child, translation, rotation } of transforms) {
      this.renderer.addTransform(parent, child, 0n, translation, rotation, settingsPath);
    }
  }

  #handleParametersChange = (parameters: ReadonlyMap<string, unknown> | undefined): void => {
    const robotDescription = parameters?.get(PARAM_NAME);
    if (typeof robotDescription === "string") {
      this.#loadUrdf({ instanceId: PARAM_KEY, urdf: robotDescription });
    }

    // Update custom layer URDFs that use parameters.
    for (const [instanceId, renderable] of this.renderables.entries()) {
      const sourceType = (renderable.userData.settings as Partial<LayerSettingsCustomUrdf>)
        .sourceType;
      const paramName = (renderable.userData.settings as Partial<LayerSettingsCustomUrdf>)
        .parameter;
      if (sourceType === "param" && paramName != undefined) {
        const urdf = parameters?.get(paramName);
        if (typeof urdf === "string") {
          this.#loadUrdf({ instanceId, urdf });
        }
      }
    }
  };

  #handleAddUrdf = (instanceId: string): void => {
    log.info(`Creating ${LAYER_ID} layer ${instanceId}`);

    const config: LayerSettingsCustomUrdf = { ...DEFAULT_CUSTOM_SETTINGS, instanceId };

    // Add this instance to the config
    this.renderer.updateConfig((draft) => {
      const maxOrderLayer = _.maxBy(Object.values(draft.layers), (layer) => layer?.order);
      const order = 1 + (maxOrderLayer?.order ?? 0);
      draft.layers[instanceId] = { ...config, order };
    });

    // Add the URDF renderable
    this.#loadUrdf({ instanceId, urdf: undefined });

    // Update the settings tree
    this.updateSettingsTree();
  };

  #beginLoad(instanceId: string): number {
    const generation = this.#loadGenerations.begin(instanceId);
    const pendingFetch = this.renderables.get(instanceId)?.userData.fetching;
    if (pendingFetch) {
      pendingFetch.control.abort();
      const renderable = this.renderables.get(instanceId);
      if (renderable) {
        renderable.userData.fetching = undefined;
      }
    }
    return generation;
  }

  #replaceLocalModels(instanceId: string, urls: Iterable<string>): void {
    for (const url of this.#localModelUrls.replace(instanceId, urls)) {
      this.renderer.modelCache.evict(url);
    }
  }

  #releaseLocalModels(instanceId: string): void {
    for (const url of this.#localModelUrls.release(instanceId)) {
      this.renderer.modelCache.evict(url);
    }
  }

  #fetchUrdf(instanceId: string, url: string, generation: number): void {
    const renderable = this.renderables.get(instanceId);
    if (!renderable) {
      throw new Error(`_fetchUrdf() should only be called for existing renderables`);
    }
    if (!this.#loadGenerations.isCurrent(instanceId, generation)) {
      return;
    }

    // Check if a valid URL was provided
    if (!isValidUrl(url)) {
      const path = renderable.userData.settingsPath;
      this.renderer.settings.errors.add(path, VALID_SRC_ERR, `Invalid URDF URL: "${url}"`);
      return;
    }
    this.renderer.settings.errors.remove(renderable.userData.settingsPath, VALID_SRC_ERR);

    log.debug(`Fetching URDF from ${url}`);
    const control = new AbortController();
    renderable.userData.fetching = { url, control };
    this.renderer
      .fetchAsset(url, { signal: control.signal })
      .then((urdf) => {
        if (
          !this.#loadGenerations.isCurrent(instanceId, generation) ||
          renderable.userData.fetching?.control !== control
        ) {
          return;
        }
        log.debug(`Fetched ${urdf.data.length} byte URDF from ${url}`);
        this.renderer.settings.errors.remove(["layers", instanceId], FETCH_URDF_ERR);
        this.#loadUrdf({
          instanceId,
          urdf: this.#textDecoder.decode(urdf.data),
          generation,
        });
      })
      .catch((unknown) => {
        if (
          !this.#loadGenerations.isCurrent(instanceId, generation) ||
          renderable.userData.fetching?.control !== control
        ) {
          return;
        }
        const err = unknown as Error;
        const hasError = !err.message.startsWith("Failed to fetch");
        const errMessage = `Failed to load URDF from "${url}"${hasError ? `: ${err.message}` : ""}`;
        this.renderer.settings.errors.add(["layers", instanceId], FETCH_URDF_ERR, errMessage);
      });
  }

  #getCurrentSettings(instanceId: string) {
    const isTopicOrParam = instanceId === TOPIC_NAME || instanceId === PARAM_KEY;
    const baseSettings = isTopicOrParam ? DEFAULT_SETTINGS : DEFAULT_CUSTOM_SETTINGS;
    const userSettings = isTopicOrParam
      ? this.renderer.config.topics[instanceId]
      : this.renderer.config.layers[instanceId];
    const settings = { ...baseSettings, ...userSettings, instanceId };
    return settings;
  }

  #loadUrdf(args: {
    instanceId: string;
    urdf?: string;
    forceReload?: boolean;
    generation?: number;
  }): void {
    const { instanceId } = args;
    const generation = args.generation ?? this.#beginLoad(instanceId);
    if (!this.#loadGenerations.isCurrent(instanceId, generation)) {
      return;
    }
    let urdf = args.urdf;
    const forceReload = args.forceReload ?? false;
    let renderable = this.renderables.get(instanceId);
    const settings = this.#getCurrentSettings(instanceId);
    const sourceType = (settings as Partial<LayerSettingsCustomUrdf>).sourceType;
    const localPackage = (settings as Partial<LayerSettingsCustomUrdf>).localPackage;
    let embeddedPackage: EmbeddedUrdfPackageResolver | undefined;
    if (sourceType === "localFiles" && localPackage) {
      try {
        embeddedPackage = new EmbeddedUrdfPackageResolver(localPackage);
        urdf ??= embeddedPackage.urdfText();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.renderer.settings.errors.add(
          ["layers", instanceId],
          VALID_SRC_ERR,
          `Invalid local URDF package: ${message}`,
        );
      }
    }
    // Reserve every package asset before parsing. A duplicate layer can still be parsing when
    // the original is deleted, and Three.js clones share geometry and materials with the cache.
    this.#replaceLocalModels(
      instanceId,
      embeddedPackage
        ? Object.keys(embeddedPackage.source.files).map((path) =>
            makeEmbeddedUrdfUrl(embeddedPackage!.source, path),
          )
        : [],
    );
    if (renderable && urdf && !forceReload && renderable.userData.urdf === urdf) {
      renderable.userData.settings = settings;
      return;
    }

    // A reparsed/deleted source must never retain this layer's old timestamped FK samples. Keep
    // pre-parse pending JointStates so a selected topic that arrived before this parse can replay.
    this.#clearJointStateLayer(instanceId, false, false);

    // Clear any previous parsed data for this instanceId
    const transforms = this.#transformsByInstanceId.get(instanceId) ?? [];
    for (const transform of transforms) {
      this.renderer.removeTransform(transform.child, transform.parent, 0n);
    }
    this.#transformsByInstanceId.delete(instanceId);
    this.#framesByInstanceId.delete(instanceId);
    this.updateSettingsTree();

    const isTopicOrParam = instanceId === TOPIC_NAME || instanceId === PARAM_KEY;
    const frameId = this.renderer.fixedFrameId ?? ""; // Unused
    const settingsPath = isTopicOrParam ? ["topics", instanceId] : ["layers", instanceId];
    const url = (settings as Partial<LayerSettingsCustomUrdf>).url;
    const filePath = (settings as Partial<LayerSettingsCustomUrdf>).filePath;
    const parameter = (settings as Partial<LayerSettingsCustomUrdf>).parameter;
    const topic = (settings as Partial<LayerSettingsCustomUrdf>).topic;
    const framePrefix = (settings as Partial<LayerSettingsCustomUrdf>).framePrefix;
    const label =
      (settings as Partial<LayerSettingsCustomUrdf>).label ?? DEFAULT_CUSTOM_SETTINGS.label;

    if (label !== renderable?.userData.settings.label) {
      // Label has changed, update the config
      this.renderer.updateConfig((draft) => {
        const config = draft.layers[instanceId];
        if (config) {
          config.label = label;
        }
      });
    }

    // Create a UrdfRenderable if it does not already exist
    if (!renderable) {
      renderable = new UrdfRenderable(instanceId, this.renderer, {
        urdf,
        fetching: undefined,
        renderables: new Map(),
        receiveTime: 0n,
        messageTime: 0n,
        frameId,
        pose: makePose(),
        settingsPath,
        settings,
        sourceType,
        topic,
        parameter,
      });
      this.add(renderable);
      this.renderables.set(instanceId, renderable);
    }

    renderable.userData.urdf = urdf;
    renderable.userData.sourceType = sourceType;
    renderable.userData.topic = topic;
    renderable.userData.parameter = parameter;
    renderable.userData.settings = settings;
    renderable.userData.fetching = undefined;

    if (!urdf || forceReload) {
      renderable.removeChildren();
    }

    if (!urdf) {
      const path = renderable.userData.settingsPath;
      this.renderer.settings.errors.remove(path, PARSE_URDF_ERR);
      this.renderer.settings.errors.remove(path, MISSING_TRANSFORM);
      if (sourceType === "url") {
        if (url != undefined) {
          this.#fetchUrdf(instanceId, url, generation);
        } else {
          this.renderer.settings.errors.add(path, VALID_SRC_ERR, `Invalid URDF URL: "${url}"`);
        }
      } else if (sourceType === "filePath") {
        if (filePath != undefined) {
          this.#fetchUrdf(instanceId, `file://${filePath}`, generation);
        } else {
          const errMsg = `Invalid File Path: "${filePath}"`;
          this.renderer.settings.errors.add(path, VALID_SRC_ERR, errMsg);
        }
      } else if (sourceType === "localFiles") {
        this.renderer.settings.errors.add(
          path,
          VALID_SRC_ERR,
          "Choose a directory package containing exactly one .urdf file",
        );
      } else if (sourceType === "param") {
        this.renderer.settings.errors.add(path, VALID_SRC_ERR, `Invalid Parameter: "${parameter}"`);
      } else if (sourceType === "topic") {
        this.renderer.settings.errors.add(path, VALID_SRC_ERR, `Invalid Topic: "${topic}"`);
      }
      return;
    } else {
      this.renderer.settings.errors.remove(renderable.userData.settingsPath, VALID_SRC_ERR);
    }

    let baseUrl: string | undefined;
    if (sourceType === "url") {
      baseUrl = url;
    } else if (sourceType === "filePath") {
      baseUrl = `file://${filePath}`;
    } else if (embeddedPackage) {
      baseUrl = embeddedPackage.urdfUrl();
    }

    // Parse the URDF
    const loadedRenderable = renderable;
    parseUrdf(
      urdf,
      async (uri) =>
        embeddedPackage
          ? await this.#getEmbeddedPackageFile(embeddedPackage, uri)
          : await this.#getFileFetch(uri, baseUrl),
      framePrefix,
    )
      .then((parsed) => {
        if (!this.#loadGenerations.isCurrent(instanceId, generation)) {
          return;
        }
        this.#loadRobot(loadedRenderable, parsed, baseUrl, embeddedPackage);
        this.renderer.settings.errors.remove(
          loadedRenderable.userData.settingsPath,
          PARSE_URDF_ERR,
        );
        // the frame from the settings update is called before the robot is loaded
        // need to queue another animation frame after robot has been loaded
        this.renderer.queueAnimationFrame();
      })
      .catch((unknown) => {
        if (!this.#loadGenerations.isCurrent(instanceId, generation)) {
          return;
        }
        const err = unknown as Error;
        log.error(`Failed to parse URDF: ${err.message}`);
        this.renderer.settings.errors.add(
          settingsPath,
          PARSE_URDF_ERR,
          `Failed to parse URDF: ${err.message}`,
        );
      });
  }

  #debouncedLoadUrdf = _.debounce(this.#loadUrdf.bind(this), 500);

  #loadRobot(
    renderable: UrdfRenderable,
    { robot, frames, transforms }: ParsedUrdf,
    baseUrl: string | undefined,
    embeddedPackage?: EmbeddedUrdfPackageResolver,
  ): void {
    const renderer = this.renderer;
    const settings = renderable.userData.settings;
    const instanceId = settings.instanceId;
    const displayMode = settings.displayMode;
    const fallbackColor = settings.fallbackColor
      ? stringToRgba(makeRgba(), settings.fallbackColor)
      : undefined;

    this.#loadFrames(instanceId, frames);
    this.#loadTransforms(instanceId, transforms);
    this.updateSettingsTree();

    // Dispose any existing renderables. The cache reservation was updated before parsing so a
    // duplicated or asynchronously loading layer keeps shared model resources alive.
    renderable.removeChildren();

    const createChild = (frameId: string, i: number, visual: UrdfVisual): void => {
      const childRenderable = createRenderable({
        visual,
        robot,
        id: i,
        frameId,
        renderer,
        baseUrl,
        embeddedPackage,
        fallbackColor,
      });
      // Set the childRenderable settingsPath so errors route to the correct place
      childRenderable.userData.settingsPath = renderable.userData.settingsPath;
      renderable.userData.renderables.set(childRenderable.name, childRenderable);
      renderable.add(childRenderable);
    };

    // Create a renderable for each link
    for (const link of robot.links.values()) {
      const frameId = link.name;
      const renderVisual = displayMode !== "collision";
      const renderCollision =
        displayMode === "collision" || (displayMode === "auto" && link.visuals.length === 0);

      if (renderVisual) {
        for (let i = 0; i < link.visuals.length; i++) {
          createChild(frameId, i, link.visuals[i]!);
        }
      }

      if (renderCollision) {
        for (let i = 0; i < link.colliders.length; i++) {
          createChild(frameId, i, link.colliders[i]!);
        }
      }
    }
  }

  #loadFrames(instanceId: string, frames: string[]): void {
    this.#framesByInstanceId.set(instanceId, frames);

    // Import all coordinate frames from the URDF into the scene
    for (const frameId of frames) {
      this.renderer.addCoordinateFrame(frameId);
    }
  }

  #loadTransforms(instanceId: string, transforms: TransformData[]): void {
    this.#transformsByInstanceId.set(instanceId, transforms);

    // Import all transforms from the URDF into the scene
    const isTopicOrParam = instanceId === TOPIC_NAME || instanceId === PARAM_KEY;
    const settingsPath = isTopicOrParam ? ["topics", instanceId] : ["layers", instanceId];
    for (const { parent, child, translation, rotation } of transforms) {
      this.renderer.addTransform(parent, child, 0n, translation, rotation, settingsPath);
    }
    this.#replayPendingJointStates(instanceId, transforms);
  }

  async #getFileFetch(url: string, referenceUrl?: string): Promise<string> {
    try {
      log.debug(`fetch(${url}) requested`);
      const asset = await this.renderer.fetchAsset(url, { referenceUrl });
      return this.#textDecoder.decode(asset.data);
    } catch (err) {
      throw new Error(`Failed to fetch "${url}": ${err}`);
    }
  }

  async #getEmbeddedPackageFile(
    embeddedPackage: EmbeddedUrdfPackageResolver,
    url: string,
  ): Promise<string> {
    try {
      const asset = await embeddedPackage.fetchAsset(url, { referenceUrl: embeddedPackage.urdfUrl() });
      return this.#textDecoder.decode(asset.data);
    } catch (error) {
      throw new Error(`Failed to load "${url}" from the local URDF package: ${error}`);
    }
  }
}

type LocalUrdfPackageSelection = {
  packageName: string;
  files: Array<{ path: string; file: File }>;
};

async function selectLocalUrdfPackageFiles(): Promise<LocalUrdfPackageSelection | undefined> {
  if (typeof showDirectoryPicker === "function") {
    try {
      const directory = await showDirectoryPicker();
      return {
        packageName: directory.name,
        files: await collectDirectoryFiles(directory),
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return undefined;
      }
      throw error;
    }
  }
  return await selectDirectoryFilesWithInput();
}

async function collectDirectoryFiles(
  directory: FileSystemDirectoryHandle,
  prefix = "",
): Promise<Array<{ path: string; file: File }>> {
  const files: Array<{ path: string; file: File }> = [];
  for await (const [name, entry] of directory.entries()) {
    const path = `${prefix}${name}`;
    if (entry.kind === "file") {
      files.push({ path, file: await entry.getFile() });
    } else {
      files.push(...(await collectDirectoryFiles(entry, `${path}/`)));
    }
  }
  return files;
}

async function selectDirectoryFilesWithInput(): Promise<LocalUrdfPackageSelection | undefined> {
  return await new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.setAttribute("webkitdirectory", "");
    input.style.display = "none";
    document.body.append(input);

    const finish = (result: LocalUrdfPackageSelection | undefined) => {
      input.remove();
      resolve(result);
    };
    input.addEventListener(
      "change",
      () => {
        const selectedFiles = Array.from(input.files ?? []);
        if (selectedFiles.length === 0) {
          finish(undefined);
          return;
        }
        const relativePaths = selectedFiles.map((file) => file.webkitRelativePath || file.name);
        const packageName = relativePaths[0]!.split("/")[0]!;
        const files = selectedFiles.map((file, index) => {
          const relativePath = relativePaths[index]!;
          const firstSlash = relativePath.indexOf("/");
          return {
            path: firstSlash === -1 ? relativePath : relativePath.slice(firstSlash + 1),
            file,
          };
        });
        finish({ packageName, files });
      },
      { once: true },
    );
    input.addEventListener(
      "cancel",
      () => {
        finish(undefined);
      },
      { once: true },
    );
    input.click();
  });
}

async function parseUrdf(
  text: string,
  getFileContents: (url: string) => Promise<string>,
  framePrefix?: string,
): Promise<ParsedUrdf> {
  const applyFramePrefix = (name: string) => `${framePrefix}${name}`;
  try {
    log.debug(`Parsing ${text.length} byte URDF`);
    const robot = await parseRobot(text, getFileContents);

    if (framePrefix) {
      robot.links = new Map(
        [...robot.links].map(([name, link]) => [
          applyFramePrefix(name),
          { ...link, name: applyFramePrefix(link.name) },
        ]),
      );
      robot.joints = new Map(
        [...robot.joints].map(([name, joint]) => [
          name,
          {
            ...joint,
            parent: applyFramePrefix(joint.parent),
            child: applyFramePrefix(joint.child),
          },
        ]),
      );
    }

    const frames = Array.from(robot.links.values(), (link) => link.name);
    const transforms = Array.from(robot.joints.values(), (joint) => {
      const translation = joint.origin.xyz;
      const rotation = eulerToQuaternion(joint.origin.rpy);
      const transform: TransformData = {
        parent: joint.parent,
        child: joint.child,
        translation,
        rotation,
        joint,
      };
      return transform;
    });

    return { robot, frames, transforms };
  } catch (err) {
    throw new Error(`Failed to parse ${text.length} byte URDF: ${err}`);
  }
}

function createRenderable(args: {
  visual: UrdfVisual;
  robot: UrdfRobot;
  id: number;
  frameId: string;
  renderer: IRenderer;
  baseUrl?: string;
  embeddedPackage?: EmbeddedUrdfPackageResolver;
  fallbackColor?: ColorRGBA;
}): Renderable {
  const { visual, robot, id, frameId, renderer, baseUrl, embeddedPackage, fallbackColor } = args;
  const name = `${frameId}-${id}-${visual.geometry.geometryType}`;
  const orientation = eulerToQuaternion(visual.origin.rpy);
  const pose = { position: visual.origin.xyz, orientation };
  const color = getColor(visual, robot) ?? fallbackColor ?? DEFAULT_COLOR;
  const type = visual.geometry.geometryType;
  switch (type) {
    case "box": {
      const scale = visual.geometry.size;
      const marker = createMarker(frameId, MarkerType.CUBE, pose, scale, color);
      return new RenderableCube(name, marker, undefined, renderer);
    }
    case "cylinder": {
      const cylinder = visual.geometry;
      const scale = { x: cylinder.radius * 2, y: cylinder.radius * 2, z: cylinder.length };
      const marker = createMarker(frameId, MarkerType.CUBE, pose, scale, color);
      return new RenderableCylinder(name, marker, undefined, renderer);
    }
    case "sphere": {
      const sphere = visual.geometry;
      const scale = { x: sphere.radius * 2, y: sphere.radius * 2, z: sphere.radius * 2 };
      const marker = createMarker(frameId, MarkerType.CUBE, pose, scale, color);
      return new RenderableSphere(name, marker, undefined, renderer);
    }
    case "mesh": {
      const isCollada = visual.geometry.filename.toLowerCase().endsWith(".dae");
      // Use embedded materials if the mesh is a Collada file
      const embedded = isCollada ? EmbeddedMaterialUsage.Use : EmbeddedMaterialUsage.Ignore;
      const marker = createMeshMarker(
        frameId,
        pose,
        embedded,
        visual.geometry,
        baseUrl,
        color,
        embeddedPackage,
      );
      return new RenderableMeshResource(name, marker, undefined, renderer, {
        referenceUrl: baseUrl,
        fetchAsset: embeddedPackage?.fetchAsset,
        resolveUrl: embeddedPackage?.resolveToDataUrl,
        preserveCachedResources: embeddedPackage != undefined,
      });
    }
    default:
      throw new Error(`Unrecognized visual geometryType: ${type}`);
  }
}

function getColor(visual: UrdfVisual, robot: UrdfRobot): ColorRGBA | undefined {
  if (!visual.material) {
    return undefined;
  }
  if (visual.material.color) {
    return visual.material.color;
  }
  if (visual.material.name) {
    return robot.materials.get(visual.material.name)?.color;
  }
  return undefined;
}

function createMarker(
  frameId: string,
  type: MarkerType,
  pose: Pose,
  scale: Vector3,
  color: ColorRGBA,
): Marker {
  return {
    header: { frame_id: frameId, stamp: { sec: 0, nsec: 0 } },
    ns: "",
    id: 0,
    type,
    action: MarkerAction.ADD,
    pose,
    scale,
    color,
    lifetime: { sec: 0, nsec: 0 },
    frame_locked: true,
    points: [],
    colors: [],
    text: "",
    mesh_resource: "",
    mesh_use_embedded_materials: false,
  };
}

function createMeshMarker(
  frameId: string,
  pose: Pose,
  embeddedMaterialUsage: EmbeddedMaterialUsage,
  mesh: UrdfGeometryMesh,
  baseUrl: string | undefined,
  color: ColorRGBA,
  embeddedPackage?: EmbeddedUrdfPackageResolver,
): Marker {
  const scale = mesh.scale ?? VEC3_ONE;
  const meshResource = embeddedPackage
    ? embeddedPackage.resolve(mesh.filename, embeddedPackage.source.urdfPath)?.url
    : new URL(mesh.filename, baseUrl).toString();
  if (!meshResource) {
    throw new Error(`Local URDF package does not contain mesh "${mesh.filename}"`);
  }
  return {
    header: { frame_id: frameId, stamp: { sec: 0, nsec: 0 } },
    ns: "",
    id: 0,
    type: MarkerType.MESH_RESOURCE,
    action: MarkerAction.ADD,
    pose,
    scale,
    color,
    lifetime: { sec: 0, nsec: 0 },
    frame_locked: true,
    points: [],
    colors: [],
    text: "",
    mesh_resource: meshResource,
    mesh_use_embedded_materials: embeddedMaterialUsage === EmbeddedMaterialUsage.Use,
  };
}

const VALID_PROTOCOLS = ["https:", "http:", "file:", "data:", "package:"];

function isValidUrl(str: string): boolean {
  try {
    const url = new URL(str);
    return VALID_PROTOCOLS.includes(url.protocol);
  } catch (_err) {
    return false;
  }
}

function urdfChildren(
  transforms: TransformData[] | undefined,
  transformTree: TransformTree,
  jointStates: ReadonlyMap<string, JointPosition> | undefined,
): SettingsTreeChildren {
  if (!transforms) {
    return {};
  }

  const jointChildren: SettingsTreeChildren = {};
  for (const { joint } of transforms) {
    const frameId = joint.child;
    const frame = transformTree.getOrCreateFrame(frameId);

    const { x, y, z } = joint.origin.xyz;
    const { x: roll, y: pitch, z: yaw } = joint.origin.rpy;
    const { x: aX, y: aY, z: aZ } = joint.axis;
    const fields: SettingsTreeFields = {};
    fields.jointType = {
      label: "Type",
      input: "string",
      readonly: true,
      value: joint.jointType,
    };

    switch (joint.jointType) {
      case "fixed":
        break;
      case "continuous":
      case "revolute": {
        const min = joint.limit ? joint.limit.lower * RAD2DEG : -180;
        const max = joint.limit ? joint.limit.upper * RAD2DEG : 180;
        let manualDegrees: number | undefined;
        const jointStateRadians = jointStates?.get(joint.name)?.position;

        if (frame.offsetEulerDegrees) {
          // Convert the Euler degrees to a quaternion
          const quaternion = eulerDegreesToQuaternion(frame.offsetEulerDegrees);
          const radians = signedAngleAroundAxis(quaternion, joint.axis);
          manualDegrees = radians * RAD2DEG;
        }

        fields.manual = {
          label: "Manual angle",
          input: "number",
          precision: PRECISION_DEGREES,
          step: 1,
          min,
          max,
          value: manualDegrees,
        };

        if (jointStateRadians != undefined) {
          fields.jointState = {
            label: "JointState angle",
            input: "number",
            precision: PRECISION_DEGREES,
            min,
            max,
            readonly: true,
            value: jointStateRadians * RAD2DEG,
          };
        }
        break;
      }
      case "prismatic": {
        const min = joint.limit?.lower;
        const max = joint.limit?.upper;
        const manualPosition = frame.offsetPosition
          ? signedDistanceAlongAxis(frame.offsetPosition, joint.axis)
          : undefined;
        const jointStatePosition = jointStates?.get(joint.name)?.position;

        fields.manual = {
          label: "Manual position",
          input: "number",
          precision: PRECISION_DISTANCE,
          step: 0.01,
          min,
          max,
          value: manualPosition,
        };
        if (jointStatePosition != undefined) {
          fields.jointState = {
            label: "JointState position",
            input: "number",
            precision: PRECISION_DISTANCE,
            min,
            max,
            readonly: true,
            value: jointStatePosition,
          };
        }
        break;
      }
      case "floating":
      case "planar":
        // Motion could be supported for these types in the future
        break;
    }

    fields.position = {
      label: "Position",
      input: "vec3",
      labels: XYZ_LABEL,
      precision: PRECISION_DISTANCE,
      readonly: true,
      value: [x, y, z],
    };
    fields.rotation = {
      label: "Rotation",
      input: "vec3",
      labels: RPY_LABEL,
      precision: PRECISION_DEGREES,
      readonly: true,
      value: [roll * RAD2DEG, pitch * RAD2DEG, yaw * RAD2DEG],
    };
    fields.parent = {
      label: "Parent",
      input: "string",
      readonly: true,
      value: joint.parent,
    };
    fields.child = {
      label: "Child",
      input: "string",
      readonly: true,
      value: joint.child,
    };
    if (joint.jointType !== "fixed") {
      fields.axis = {
        label: "Axis",
        input: "vec3",
        labels: XYZ_LABEL,
        precision: PRECISION_DISTANCE,
        readonly: true,
        value: [aX, aY, aZ],
      };
    }
    if (joint.calibration) {
      const { rising, falling } = joint.calibration;
      fields.calibration = {
        label: "Calibration",
        input: "vec2",
        labels: ["↑", "↓"],
        readonly: true,
        value: [rising, falling],
      };
    }
    if (joint.dynamics) {
      const { damping, friction } = joint.dynamics;
      fields.damping = {
        label: "Damping",
        input: "number",
        precision: PRECISION_DISTANCE,
        readonly: true,
        value: damping,
      };
      fields.friction = {
        label: "Friction",
        input: "number",
        precision: PRECISION_DISTANCE,
        readonly: true,
        value: friction,
      };
    }
    if (joint.limit) {
      const { effort, velocity } = joint.limit;
      if (joint.jointType !== "continuous" && joint.jointType !== "fixed") {
        const { upper, lower } = joint.limit;
        const isAngular = joint.jointType === "revolute";
        const upperValue = isAngular ? upper * RAD2DEG : upper;
        const lowerValue = isAngular ? lower * RAD2DEG : lower;
        fields.limit = {
          label: "Limit",
          input: "vec2",
          labels: ["↑", "↓"],
          readonly: true,
          precision: isAngular ? PRECISION_DEGREES : PRECISION_DISTANCE,
          value: [upperValue, lowerValue],
        };
      }
      fields.effort = {
        label: "Limit effort",
        input: "number",
        precision: PRECISION_DISTANCE,
        readonly: true,
        value: effort,
      };
      fields.velocity = {
        label: "Limit velocity",
        input: "number",
        precision: PRECISION_DISTANCE,
        readonly: true,
        value: velocity,
      };
    }
    if (joint.mimic) {
      const { joint: mimicJoint, multiplier, offset } = joint.mimic;
      fields.mimicJoint = {
        label: "Mimic joint",
        input: "string",
        readonly: true,
        value: mimicJoint,
      };
      fields.mimicMultiplier = {
        label: "Mimic multiplier",
        input: "number",
        precision: PRECISION_DISTANCE,
        readonly: true,
        value: multiplier,
      };
      fields.mimicOffset = {
        label: "Mimic offset",
        input: "number",
        precision: PRECISION_DISTANCE,
        readonly: true,
        value: offset,
      };
    }
    if (joint.safetyController) {
      const { softUpperLimit, softLowerLimit, kPosition, kVelocity } = joint.safetyController;
      fields.softLimit = {
        label: "Soft limit",
        input: "vec2",
        labels: ["↑", "↓"],
        readonly: true,
        value: [softUpperLimit, softLowerLimit],
      };
      fields.kPosition = {
        label: "k_position",
        input: "number",
        precision: PRECISION_DISTANCE,
        readonly: true,
        value: kPosition,
      };
      fields.kVelocity = {
        label: "k_velocity",
        input: "number",
        precision: PRECISION_DISTANCE,
        readonly: true,
        value: kVelocity,
      };
    }
    jointChildren[joint.name] = { label: joint.name, fields, defaultExpansionState: "collapsed" };
  }

  const children: SettingsTreeChildren = {
    joints: {
      label: "Joints",
      defaultExpansionState: "collapsed",
      children: jointChildren,
    },
  };
  return children;
}

function eulerDegreesToQuaternion(eulerDegrees: vec3): THREE.Quaternion {
  tempEuler.set(eulerDegrees[0] * DEG2RAD, eulerDegrees[1] * DEG2RAD, eulerDegrees[2] * DEG2RAD);
  return tempQuaternion1.setFromEuler(tempEuler);
}

function signedDistanceAlongAxis(position: Readonly<vec3>, axis: Readonly<Vector3>): number {
  const p = tempVec3a.set(position[0], position[1], position[2]);
  const targetAxis = tempVec3b.set(axis.x, axis.y, axis.z);

  // Project the position on to axis
  p.projectOnVector(targetAxis);
  const distance = p.length();

  // Calculate the sign
  const dotProduct = p.dot(targetAxis);
  const sign = dotProduct < 0 ? -1 : 1;

  return sign * distance;
}

// Find the signed angle of a rotation around a given axis
function signedAngleAroundAxis(rotation: Readonly<Quaternion>, axis: Readonly<Vector3>): number {
  const rotationAxis = tempVec3a.set(rotation.x, rotation.y, rotation.z);
  const targetAxis = tempVec3b.set(axis.x, axis.y, axis.z);

  // Project the rotation axis onto the given axis
  const p = rotationAxis.projectOnVector(targetAxis);

  // Create a twist quaternion from the projected axis and original rotation angle
  const twist = tempQuaternion2.set(p.x, p.y, p.z, rotation.w);
  twist.normalize();

  // Calculate the twist angle ([0, PI])
  const angle = 2 * Math.acos(twist.w);

  // Calculate the sign of the twist angle
  const dotProduct = tempVec3a.set(twist.x, twist.y, twist.z).dot(targetAxis);
  const sign = dotProduct < 0 ? -1 : 1;

  return sign * angle;
}
