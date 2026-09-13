-- Where the studio's booking notices are delivered, separate from the organizer's sign-in address.
ALTER TABLE "Workspace" ADD COLUMN "notificationEmail" TEXT;
