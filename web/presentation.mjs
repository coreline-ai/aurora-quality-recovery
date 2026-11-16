const timestamp=new Intl.DateTimeFormat('ko-KR',{
  timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23',
});

export function formatTimestamp(value,{dayOnly=false}={}) {
  if (!value) return '—';
  const parts=Object.fromEntries(timestamp.formatToParts(new Date(value)).map(({type,value})=>[type,value]));
  const day=`${parts.year}.${parts.month}.${parts.day}`;
  return dayOnly?day:`${day} ${parts.hour}:${parts.minute}`;
}

export const formatCaseId=value=>value?.slice(0,8).toUpperCase();

const tones={
  WAITING_APPROVAL:'approval',PENDING_APPROVAL:'approval',READY_TO_CLOSE:'approval',AWAITING_DECISION:'approval',
  WAITING_INFORMATION:'attention',NEEDS_INFORMATION:'attention',WAITING_EVIDENCE:'attention',BLOCKED:'attention',UNKNOWN:'attention',REAPPROVAL_REQUIRED:'attention',
  EXPIRED:'late',FAILED:'late',DEGRADED:'late',AI_NOT_CONFIGURED:'late',REJECTED:'attention',
  OPEN:'active',EXECUTING:'active',RUNNING:'active',READY:'active',APPROVED:'active',ANSWERED:'active',SUCCEEDED:'active',
  CLOSED:'closed',COMPLETED:'closed',
};
export const statusTone=value=>tones[value]??'neutral';
