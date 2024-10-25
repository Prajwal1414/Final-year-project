import express, { Express } from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import getVirtualboxFiles from "./getVirtualboxFiles";
import { z } from "zod";
import {
  createFile,
  deleteFile,
  generateCode,
  getFolder,
  getProjectSize,
  renameFile,
  saveFile,
  testDescribe,
} from "./utils";
import path from "path";
import fs from "fs";
import { IDisposable, IPty, spawn } from "node-pty";
import os from "os";
import {
  MAX_BODY_SIZE,
  createFileRL,
  createFolderRL,
  deleteFileRL,
  renameFileRL,
  saveFileRL,
} from "./ratelimit";

const app: Express = express();
const port = process.env.PORT || 4000;

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
  },
});

let inactivityTimeout: NodeJS.Timeout | null = null;
let isOwnerConnected = false;

const terminals: {
  [id: string]: {
    terminal: IPty;
    onData: IDisposable;
    onExit: IDisposable;
  };
} = {};

const dirName = path.join(__dirname, "..");

const handshakeSchema = z.object({
  userId: z.string(),
  virtualboxId: z.string(),
  EIO: z.string(),
  transport: z.string(),
  t: z.string(),
});

io.use(async (socket, next) => {
  const q = socket.handshake.query;

  const parseQuery = handshakeSchema.safeParse(q);
  if (!parseQuery.success) {
    next(new Error("Invalid request"));
    return;
  }

  const { virtualboxId, userId } = parseQuery.data;
  const dbUser = await fetch(
    `https://database.pkunofficial66.workers.dev/api/user?id=${userId}`
  );
  const dbUserJSON = await dbUser.json();

  if (!dbUserJSON) {
    next(new Error("DB error"));
    return;
  }

  const virtualbox = dbUserJSON.virtualbox.find(
    (v: any) => v.id === virtualboxId
  );

  const sharedVirtualboxes = dbUserJSON.usersToVirtualboxes.find(
    (utv: any) => utv.virtualboxId === virtualboxId
  );
  if (!virtualbox && !sharedVirtualboxes) {
    next(new Error("Invalid credentials"));
    return;
  }

  socket.data = {
    id: virtualboxId,
    userId,
    isOwner: virtualbox !== undefined,
  };

  next();
});

io.on("connection", async (socket) => {
  if (inactivityTimeout) clearTimeout(inactivityTimeout);
  const data = socket.data as {
    userId: string;
    id: string;
    isOwner: boolean;
  };

  if (data.isOwner) {
    isOwnerConnected = true;
  } else if (!isOwnerConnected) {
    socket.emit("disableAccess", "The virtualbox owner is not connected.");
    return;
  }

  const virtualboxFiles = await getVirtualboxFiles(data.id);
  virtualboxFiles.fileData.forEach((file) => {
    const filePath = path.join(dirName, file.id);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFile(filePath, file.data, (err) => {
      if (err) throw err;
    });
  });

  socket.emit("loaded", virtualboxFiles.files);

  socket.on("getFile", (fileId: string, callback) => {
    const file = virtualboxFiles.fileData.find((f) => f.id === fileId);
    if (!file) return;

    callback(file.data);
  });

  socket.on("saveFile", async (fileId: string, body: string) => {
    try {
      await saveFileRL.consume(data.userId, 1);

      if (Buffer.byteLength(body, "utf-8") > MAX_BODY_SIZE) {
        socket.emit(
          "rateLimit",
          "Rate limited: file size too large. Please reduce the file size."
        );
        return;
      }

      const file = virtualboxFiles.fileData.find((f) => f.id === fileId);
      if (!file) return;

      file.data = body;

      fs.writeFile(path.join(dirName, file.id), body, (err) => {
        if (err) throw err;
      });

      await saveFile(fileId, body);
    } catch (e) {
      io.emit("rateLimit", "Rate limited: file saving. Please slow down.");
    }
  });

  socket.on("createFile", async (name: string, callback) => {
    try {
      const size: number = await getProjectSize(data.id);
      if (size > 200 * 1024 * 1024) {
        io.emit(
          "rateLimit",
          "Rate Limited: project size exceeded. Please delete some files."
        );
        callback({ success: false });
        return;
      }
      await createFileRL.consume(data.userId, 1);
      const id = `projects/${data.id}/${name}`;

      fs.writeFile(path.join(dirName, id), "", (err) => {
        if (err) throw err;
      });

      virtualboxFiles.files.push({
        id,
        name,
        type: "file",
      });

      virtualboxFiles.fileData.push({
        id,
        data: "",
      });

      await createFile(id);
      callback({ success: true });
    } catch (e) {
      io.emit("rateLimit", "Rate limited: file saving. Please slow down.");
    }
  });

  socket.on("moveFile", async (fileId: string, folderId: string, callback) => {
    const file = virtualboxFiles.fileData.find((f) => f.id === fileId);
    if (!file) return;

    const parts = fileId.split("/");
    const newFileId = folderId + "/" + parts.pop();

    fs.rename(
      path.join(dirName, fileId),
      path.join(dirName, newFileId),
      (err) => {
        if (err) throw err;
      }
    );

    file.id = newFileId;

    await renameFile(fileId, newFileId, file.data);
    const newFiles = await getVirtualboxFiles(data.id);

    callback(newFiles.files);
  });

  socket.on("getFolder", async (folderId: string, callback) => {
    const files = await getFolder(folderId);
    callback(files);
  });

  socket.on("deleteFolder", async (folderId: string, callback) => {
    const files = await getFolder(folderId);

    await Promise.all(
      files.map(async (file) => {
        fs.unlink(path.join(dirName, file), (err) => {
          if (err) throw err;
        });

        virtualboxFiles.fileData = virtualboxFiles.fileData.filter(
          (f) => f.id !== file
        );

        await deleteFile(file);
      })
    );

    const newFiles = await getVirtualboxFiles(data.id);
    callback(newFiles.files);
  });

  socket.on("createFolder", async (name: string, callback) => {
    try {
      await createFolderRL.consume(data.userId, 1);

      const id = `projects/${data.id}/${name}`;

      fs.mkdir(path.join(dirName, id), { recursive: true }, (err) => {
        if (err) throw err;
      });

      callback();
    } catch (e) {
      io.emit("rateLimit", "Rate limited: folder creation. Please slow down");
    }
  });

  socket.on("deleteFile", async (fileId: string, callback) => {
    try {
      await deleteFileRL.consume(data.userId, 1);
      const file = virtualboxFiles.fileData.find((f) => f.id === fileId);
      if (!file) return;

      fs.unlink(path.join(dirName, fileId), (err) => {
        if (err) throw err;
      });

      virtualboxFiles.fileData = virtualboxFiles.fileData.filter(
        (f) => f.id !== fileId
      );

      await deleteFile(fileId);

      const newFiles = await getVirtualboxFiles(data.id);
      callback(newFiles.files);
    } catch (e) {
      io.emit("rateLimit", "Rate limited: file saving. Please slow down.");
    }
  });

  socket.on("resizeTerminal", (dimensions: { cols: number; rows: number }) => {
    Object.values(terminals).forEach((t) => {
      t.terminal.resize(dimensions.cols, dimensions.rows);
    });
  });

  socket.on("createTerminal", (id: string, callback) => {
    if (terminals[id] || Object.keys(terminals).length >= 4) {
      return;
    }
    console.log("here")

    const pty = spawn(os.platform() === "win32" ? "cmd.exe" : "bash", [], {
      name: "xterm",
      cols: 100,
      cwd: path.join(dirName, "projects", data.id),
    });

    const onData = pty.onData((data) => {
      io.emit("terminalResponse", {
        id,
        data,
      });
    });

    const onExit = pty.onExit((code) => console.log("exit:(", code));
    pty.write("echo Hello World\n");

    terminals[id] = { terminal: pty, onData, onExit };
    callback();
  });

  socket.on("terminalData", (id: string, input: string) => {
    if (terminals[id]) {
      terminals[id].terminal.write(input);
    }
  });

  socket.on("disconnect", () => {
    if (inactivityTimeout) clearTimeout(inactivityTimeout);
    inactivityTimeout = setTimeout(() => {
      isOwnerConnected = false;
      Object.keys(terminals).forEach((key) => {
        terminals[key].terminal.kill();
        terminals[key].onData.dispose();
        terminals[key].onExit.dispose();
        delete terminals[key];
      });
    }, 10000);
  });
});

httpServer.on("request",(req,res)=>{
  console.log("request")
})

httpServer.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
