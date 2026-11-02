import { invoke } from "@tauri-apps/api/core";

export type PreparedImage = {
  id: string;
  path: string;
  name: string;
  mime: string;
  width: number;
  height: number;
  resized: boolean;
  kind?: "file";
  bytes?: number;
};

export function prepareImage(
  bytesBase64: string,
  name: string,
  conversationId?: string,
): Promise<PreparedImage> {
  return invoke("dev_prepare_image", {
    bytesBase64,
    bytes_base64: bytesBase64,
    name,
    conversationId: conversationId ?? null,
    conversation_id: conversationId ?? null,
  });
}

export function prepareImagePath(
  path: string,
  conversationId?: string,
): Promise<PreparedImage> {
  return invoke("dev_prepare_image_path", {
    path,
    conversationId: conversationId ?? null,
    conversation_id: conversationId ?? null,
  });
}

export function prepareFile(
  bytesBase64: string,
  name: string,
  conversationId?: string,
): Promise<PreparedImage> {
  return invoke("dev_prepare_file", {
    bytesBase64,
    bytes_base64: bytesBase64,
    name,
    conversationId: conversationId ?? null,
    conversation_id: conversationId ?? null,
  });
}

export function prepareFilePath(
  path: string,
  conversationId?: string,
): Promise<PreparedImage> {
  return invoke("dev_prepare_file_path", {
    path,
    conversationId: conversationId ?? null,
    conversation_id: conversationId ?? null,
  });
}

export function stageDropPath(path: string, conversationId?: string): Promise<PreparedImage> {
  return invoke("dev_stage_drop_path", {
    path,
    conversationId: conversationId ?? null,
    conversation_id: conversationId ?? null,
  });
}

export function finalizeImage(path: string): Promise<PreparedImage> {
  return invoke("dev_finalize_image", { path });
}

export function imageDataUrl(path: string): Promise<string> {
  return invoke("dev_image_data_url", { path });
}

export function setSpaceCornerImage(path: string): Promise<PreparedImage> {
  return invoke("dev_set_space_corner_image", { path });
}

export function spaceCornerImage(): Promise<PreparedImage | null> {
  return invoke("dev_space_corner_image");
}

export function clearSpaceCornerImage(): Promise<void> {
  return invoke("dev_clear_space_corner_image");
}
