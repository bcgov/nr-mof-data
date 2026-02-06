UPDATE the.euser_feedback
   SET feedback_category_code = 'GEN'
     , update_userid = 'SYSTEM'
     , update_timestamp = SYSDATE
     , revision_count = revision_count + 1;


