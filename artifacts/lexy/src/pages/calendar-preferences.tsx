import { AppLayout } from "@/components/layout/AppLayout";
import { CalendarWorkingHours } from "@/components/scheduling/CalendarWorkingHours";
import { CalendarPanelConsent } from "@/components/scheduling/CalendarPanelConsent";
import { GoogleStaffCalendar } from "@/components/scheduling/GoogleStaffCalendar";
import { GoogleCalendarPilot } from "@/components/scheduling/GoogleCalendarPilot";
import { ZoomStaffAccount } from "@/components/scheduling/ZoomStaffAccount";
import { GoogleMeetRecordingAccount } from "@/components/scheduling/GoogleMeetRecordingAccount";

export default function CalendarPreferences() {
  return (
    <AppLayout>
      <div className="max-w-3xl mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Calendar preferences</h1>
          <p className="text-sm text-muted-foreground mt-2">
            Manage your own working hours and panel-availability sharing. These settings do not
            publish candidate slots, reserve calendars or send invitations. Working hours can be
            saved without connecting Outlook; sharing requires an existing calendar connection.
          </p>
        </div>
        <CalendarWorkingHours />
        <CalendarPanelConsent />
        <GoogleStaffCalendar />
        <GoogleMeetRecordingAccount />
        <ZoomStaffAccount />
        <GoogleCalendarPilot />
      </div>
    </AppLayout>
  );
}
