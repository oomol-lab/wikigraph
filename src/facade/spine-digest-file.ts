import { mkdir, mkdtemp, rename, rm } from "fs/promises";
import { dirname, join, resolve } from "path";
import { tmpdir } from "os";

import { DirectoryDocument } from "../document/index.js";

import { extractSdpubArchive, writeSdpubArchive } from "./archive.js";
import { SpineDigest } from "./spine-digest.js";

export class SpineDigestFile {
  readonly #path: string;

  public constructor(path: string) {
    this.#path = resolve(path);
  }

  public async openSession<T>(
    operation: (digest: SpineDigest) => Promise<T> | T,
    options: {
      readonly documentDirPath?: string;
    } = {},
  ): Promise<T> {
    const directoryPath =
      options.documentDirPath === undefined
        ? await mkdtemp(join(tmpdir(), "spinedigest-open-"))
        : resolve(options.documentDirPath);

    try {
      await extractSdpubArchive(this.#path, directoryPath);

      const document = await DirectoryDocument.open(directoryPath);

      try {
        return await operation(new SpineDigest(document, directoryPath));
      } finally {
        await document.release();
      }
    } finally {
      if (options.documentDirPath === undefined) {
        await rm(directoryPath, { force: true, recursive: true });
      }
    }
  }

  public async openEditableSession<T>(
    operation: (document: DirectoryDocument) => Promise<T> | T,
  ): Promise<T> {
    const directoryPath = await mkdtemp(join(tmpdir(), "spinedigest-edit-"));

    try {
      await extractSdpubArchive(this.#path, directoryPath);

      const document = await DirectoryDocument.open(directoryPath);

      try {
        const result = await operation(document);
        const temporaryOutputDirectoryPath = await mkdtemp(
          join(tmpdir(), "spinedigest-save-"),
        );
        const temporaryOutputPath = join(
          temporaryOutputDirectoryPath,
          "document.sdpub",
        );

        try {
          await document.flush();
          await writeSdpubArchive(directoryPath, temporaryOutputPath);
          await mkdir(dirname(this.#path), { recursive: true });
          await rename(temporaryOutputPath, this.#path);
        } finally {
          await rm(temporaryOutputDirectoryPath, {
            force: true,
            recursive: true,
          });
        }
        return result;
      } finally {
        await document.release();
      }
    } finally {
      await rm(directoryPath, { force: true, recursive: true });
    }
  }
}
